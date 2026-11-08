/**
 * The theme-stylesheet fixtures the `plugins` smoke plants (plan §5.1/§5.4, spec §3.2/§4.2).
 *
 * Two packages, because the two answers that matter are different: one declares a theme with a
 * stylesheet and an asset list under both theme permissions, and one declares the same theme with
 * only `ui.theme` - where the whole desktop block has to be refused rather than projecting a theme
 * whose stylesheet was silently dropped. The `.css` and the asset are written but read by nobody
 * here: the host projects the *declared* paths, and Rust is the half that reads the bytes.
 *
 * Split out of `plugins.fixtures.ts` when that file reached the line limit (`rules.md#single-file-line-limit`); the
 * package writer and registry writer are the same ones every other stage uses.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot } from '../client.ts'
import { PLUGIN_VERSION, writeInstalledRecord } from './plugins.fixtures.ts'

/** A third-party package whose theme declares a stylesheet and one asset. */
export const THEME_CSS_ID = 'smoke-theme-css@smoke-market'
export const THEME_CSS_ROOT = path.join(dataRoot, 'smoke-theme-css')

/** The same theme without `ui.theme.css`: the block must be refused whole. */
export const THEME_CSS_UNPERMITTED_ID = 'smoke-theme-css-bare@smoke-market'
export const THEME_CSS_UNPERMITTED_ROOT = path.join(dataRoot, 'smoke-theme-css-bare')

/** The declared stylesheet and assets, shared with the stage's checks. */
export const THEME_CSS_PATH = 'desktop/themes/theme.css'
export const THEME_CSS_ASSETS = ['desktop/themes/backdrop.svg'] as const

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

/** Writes one package directory: a token theme plus the stylesheet it declares. */
function writeThemePackage(root: string, permissions: string[]): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'desktop', 'themes'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      name: path.basename(root),
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          permissions,
          themes: [
            {
              id: 'smoke-css',
              label: { en: 'Smoke CSS' },
              tokens: { '--omp-accent': '#7c3aed' },
              css: THEME_CSS_PATH,
              assets: [...THEME_CSS_ASSETS],
            },
          ],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  // Written but read by nobody in this stage: the host projects the declared paths, Rust reads and
  // sanitises the file (plan §5.2).
  fs.writeFileSync(path.join(root, ...THEME_CSS_PATH.split('/')), ':root{--omp-accent:#7c3aed}\n', 'utf8')
  fs.writeFileSync(
    path.join(root, ...THEME_CSS_ASSETS[0].split('/')),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#7c3aed"/></svg>\n',
    'utf8',
  )
}

/** Plants both theme fixtures as registry records. */
export function plantThemeCssFixtures(): void {
  writeThemePackage(THEME_CSS_ROOT, ['ui.theme', 'ui.theme.css'])
  writeInstalledRecord(THEME_CSS_ID, installRecord(THEME_CSS_ROOT))

  writeThemePackage(THEME_CSS_UNPERMITTED_ROOT, ['ui.theme'])
  writeInstalledRecord(THEME_CSS_UNPERMITTED_ID, installRecord(THEME_CSS_UNPERMITTED_ROOT))
}

/** Removes both fixtures and their registry records. */
export function removeThemeCssFixtures(): void {
  fs.rmSync(THEME_CSS_ROOT, { recursive: true, force: true })
  fs.rmSync(THEME_CSS_UNPERMITTED_ROOT, { recursive: true, force: true })
  writeInstalledRecord(THEME_CSS_ID, null)
  writeInstalledRecord(THEME_CSS_UNPERMITTED_ID, null)
}

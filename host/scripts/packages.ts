/**
 * Package layout the build driver and the artifact checks have to agree on.
 *
 * `build.ts` picks the addon to embed from the package this resolves, and `provenance.ts` compares
 * the artifact back against the same resolution; when the two carried their own copy the failure
 * text had already drifted (`Cannot` in one, `cannot` in the other), which is the shape of a
 * disagreement that matters the first time a resolution changes. Runtime code never imports this:
 * both callers are tooling.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Platform tag of this build host (`win32-x64`).
 *
 * It keys two things that have to agree: the `@oh-my-pi/pi-natives-<tag>` leaf package the addon
 * is read from, and the `platformTag` the loader compares against `${process.platform}-${process.arch}`
 * before extracting it.
 */
export const PLATFORM_TAG = `${process.platform}-${process.arch}`

/** Resolves an installed package the way Node would, starting from a real package directory. */
export function resolvePackage(fromDir: string, name: string): string {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync.native(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`Cannot resolve ${name} from ${fromDir}`)
    dir = parent
  }
}

/**
 * The shipped bundle's directory name and manifest shape.
 *
 * One home for both sides: `build.ts` writes the manifest and `provenance.ts` verifies it, and the
 * two disagreeing about a role or a field name is exactly the drift this file exists to prevent.
 */
export const BUNDLE_DIRNAME = 'bundle'

export interface BundleFile {
  readonly file: string
  readonly role: 'bundle' | 'runtime' | 'asset' | 'addon'
  readonly bytes: number
  readonly sha256: string
}

export interface BundleManifest {
  readonly layout: 'bundle'
  readonly hostVersion: string
  readonly sdkVersion: string
  readonly bunVersion: string
  readonly protocol: number
  readonly target: string
  readonly entry: string
  readonly argv: readonly string[]
  readonly files: readonly BundleFile[]
  readonly builtAt: string
}

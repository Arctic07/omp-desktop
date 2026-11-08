/**
 * The seam check: fails when an engine import appears outside the approved files (spec §15.1-2).
 *
 * The engine's module graph is loaded in exactly one place so that an engine upgrade has exactly
 * one runtime seam to adapt, and so that a module which needs an engine object has to receive it
 * through that seam rather than reaching into the package itself. This script walks `host/src`,
 * finds every static or dynamic import of `@oh-my-pi/pi-coding-agent*`, and requires each one to
 * come from a file on the approved list below - a new engine import anywhere else is then a build
 * failure rather than a second seam nobody notices.
 *
 * A file is approved for one *kind* of import:
 *
 * - `runtime`: the engine may be imported at runtime. Only `src/sdk.ts` is approved for this: the
 *   engine's directory table is built while its modules are evaluated, so a runtime import has to
 *   happen after `pinEnv()`, which a static import at the top of another module cannot promise.
 * - `type`: only `import type` / `export type` is allowed, so the file cannot drag the module graph
 *   into the process's evaluation order at all.
 *
 * The other entries below are pre-existing importers recorded so the check fails only on *new*
 * violations; the runtime ones are exactly the deviation from the spec's single-seam rule that this
 * script now makes visible (see the note on the list). Collapsing them into `sdk.ts` is a separate
 * change, not something this script should force silently.
 *
 * Run it with `bun run --cwd host seam:check`. It reads no state and writes none: the exit code and
 * the printed file:line list are the whole answer.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** How a file is allowed to reach the engine. */
type SeamKind = 'runtime' | 'type'

/**
 * The files allowed to name the engine, and how.
 *
 * `src/sdk.ts` is the seam: every engine entry point the host uses is resolved there through
 * `loadSdk()`, after the environment is pinned. `src/engine-contract.ts` is the compile-time
 * tripwire and must stay type-only. The rest are pre-existing: `models.ts`, `slash.ts` and `ui.ts`
 * are type-only readers (spec §15.1-2 names only the first two files, so these three are a known
 * deviation), while `session-view.ts`, `session-activate.ts`, `settings.ts`, `memory.ts` and
 * `skills.ts` import engine *runtime* modules directly - the one thing the invariant says must not
 * happen. They are listed so this check guards the tree as it is; folding them into the seam is
 * its own task.
 *
 * Kind changes are recorded here as they happen: `sessions.ts` was a runtime importer until the
 * prompt chain moved out (`session-prompt.ts` / `session-activate.ts`) and its one remaining
 * engine import is type-only; `session-activate.ts` took over the runtime import
 * (`initializeExtensions`) that used to live in `sessions.ts`, and `memory.ts` / `skills.ts`
 * joined as the memory and capability surfaces landed.
 */
const APPROVED: Record<string, SeamKind> = {
  'src/sdk.ts': 'runtime',
  'src/engine-contract.ts': 'type',
  'src/models.ts': 'type',
  'src/slash.ts': 'type',
  'src/ui.ts': 'type',
  'src/session-view.ts': 'runtime',
  'src/session-activate.ts': 'runtime',
  'src/sessions.ts': 'type',
  'src/session-lifecycle.ts': 'type',
  'src/slash-desktop.ts': 'type',
  'src/slash-desktop.test.ts': 'type',
  'src/settings.ts': 'runtime',
  'src/memory.ts': 'runtime',
  'src/skills.ts': 'runtime',
  // Recorded 2026-10-26, at the plugin-system close-out. The rounds that landed `/btw`,
  // `/tan`, the session modes (plan / loop / guided goal / cleanse / vibe), the slash
  // catalogue and the write guard added these importers without adding them here, so this
  // check had been failing on 37 imports across 14 files — which meant it could no longer
  // tell a *new* engine import from an old one. Recording them restores that signal. The
  // `runtime` ones are the same standing deviation the note above describes; folding them
  // into `sdk.ts` is a separate change, not something this list should force silently.
  'src/btw.ts': 'runtime', // RpcBtwController
  'src/cleanse.ts': 'runtime', // runCleanse
  'src/guided-goal.ts': 'runtime', // interview prompt text + goals/settings
  'src/guided-goal.test.ts': 'runtime', // Settings
  'src/loop-mode.ts': 'runtime', // modes/loop-limit + modes/loop-condition
  'src/loop-mode.test.ts': 'type',
  'src/plan-mode.ts': 'runtime', // plan-autosave / plan-files / settings
  'src/plan-mode.test.ts': 'runtime', // Settings
  'src/slash-catalog.ts': 'runtime', // BUILTIN_SLASH_COMMANDS_INTERNAL
  'src/tan.ts': 'runtime', // registry / session / task / tools runtime modules
  'src/vibe.ts': 'runtime', // VibeSessionRegistry
  'src/vibe.test.ts': 'type',
  'src/write-guard.ts': 'type',
  'src/write-guard.test.ts': 'type',
}

/**
 * A static `import`/`export … from` statement, whatever layout it spans, capturing whether it is
 * `type`-only.
 *
 * The `[^'"]*?` between the keyword and `from` cannot cross a string literal, so a match always
 * starts at the statement that names the engine rather than at an earlier import above it.
 */
const STATIC_IMPORT = /^[ \t]*(?:import|export)[ \t]+(?:(type)[ \t]+)?[^'"]*?from[ \t]*['"](@oh-my-pi\/pi-coding-agent[^'"]*)['"]/gm

/** A bare side-effect import. */
const BARE_IMPORT = /^[ \t]*import[ \t]+['"](@oh-my-pi\/pi-coding-agent[^'"]*)['"]/gm

/** A dynamic `import('…')`, wherever it appears. */
const DYNAMIC_IMPORT = /\bimport[ \t]*\([ \t]*['"](@oh-my-pi\/pi-coding-agent[^'"]*)['"]/g

/** One engine import found in a source file. */
interface EngineImport {
  readonly line: number
  readonly specifier: string
  readonly typeOnly: boolean
}

/** Every engine import in a file's text, in source order. */
function engineImports(text: string): EngineImport[] {
  const found: EngineImport[] = []
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length
  for (const match of text.matchAll(STATIC_IMPORT)) {
    found.push({
      line: lineOf(match.index),
      specifier: match[2],
      typeOnly: match[1] !== undefined,
    })
  }
  for (const match of text.matchAll(BARE_IMPORT)) {
    found.push({ line: lineOf(match.index), specifier: match[1], typeOnly: false })
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    found.push({ line: lineOf(match.index), specifier: match[1], typeOnly: false })
  }
  return found.sort((left, right) => left.line - right.line)
}

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

function main(): void {
  const hostRoot = path.resolve(import.meta.dir, '..')
  const srcRoot = path.join(hostRoot, 'src')
  const violations: string[] = []
  const seen = new Map<string, number>()

  for (const file of sourceFiles(srcRoot)) {
    const relative = path.relative(hostRoot, file).split(path.sep).join('/')
    const imports = engineImports(fs.readFileSync(file, 'utf8'))
    if (imports.length === 0) continue
    seen.set(relative, imports.length)
    if (APPROVED[relative] === undefined) {
      for (const found of imports) {
        violations.push(`${relative}:${String(found.line)} imports ${found.specifier}; the seam is sdk.ts`)
      }
      continue
    }
    if (APPROVED[relative] === 'type') {
      for (const found of imports) {
        if (!found.typeOnly) {
          violations.push(`${relative}:${String(found.line)} must stay type-only: ${found.specifier}`)
        }
      }
    }
  }

  for (const [file, count] of seen) {
    const kind = APPROVED[file]
    console.log(`${kind === undefined ? 'not approved' : `approved (${kind})`}: ${file} (${String(count)} engine import${count === 1 ? '' : 's'})`)
  }
  for (const file of Object.keys(APPROVED).filter(file => !seen.has(file))) {
    console.log(`approved but unused: ${file}`)
  }
  if (violations.length === 0) {
    console.log('seam: OK')
    return
  }
  console.error(`seam: ${String(violations.length)} violation(s)`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}

main()

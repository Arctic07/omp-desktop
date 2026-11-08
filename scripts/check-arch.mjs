#!/usr/bin/env node
// Gate: dependency direction (`rules.md#layering-and-repository-layout`).
//
// A layer that only *agrees* not to import upward is one refactor away from doing it, and code
// review catches that late. These rules are the mechanical half of the layering: they name the
// edges that must not exist, parse the imports (TypeScript AST, Rust `use` trees), and fail on any
// new one. Existing violations are pinned in `scripts/arch-allowlist.json` at one entry per edge:
// an entry may only disappear, and a stale entry fails too, so the list cannot silently rot.
//
// Add a rule only when it holds today, or pin its current violations in the same change — a rule
// added red is a rule everyone learns to bypass.
//
// The TypeScript side uses the root `typescript` dependency rather than a resolver library: the
// AST already knows an import from a string in a comment or a regex.

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import ts from 'typescript'

const ROOT = process.cwd()
const ALLOWLIST = 'scripts/arch-allowlist.json'

/**
 * `source` selects the files the rule owns; `forbidRepo` fails an import under one of those
 * repository prefixes; `allowRepo` instead fails every repository import outside them (for a module
 * that must stay self-contained); `forbidRust` names `crate::` module paths.
 */
const RULES = [
  {
    id: 'host-protocol-isolation',
    lang: 'ts',
    source: 'host/src/protocol/',
    allowRepo: ['host/src/protocol/', 'host/src/constants.ts'],
    forbidExternal: ['@oh-my-pi/'],
    reason: 'the frame codec is the wire contract and must stay usable without the engine or dispatch',
  },
  {
    id: 'frontend-state-not-ui',
    lang: 'ts',
    source: 'src/src/state/',
    forbidRepo: ['src/src/components/', 'src/src/home/', 'src/src/settings/'],
    reason: 'a store that imports a view cannot be tested or reused without mounting the UI',
  },
  {
    id: 'frontend-lib-not-ui',
    lang: 'ts',
    source: 'src/src/lib/',
    forbidRepo: ['src/src/components/', 'src/src/home/', 'src/src/settings/'],
    reason: 'shared utilities and hooks sit below the surfaces that use them',
  },
  {
    id: 'rust-services-not-commands',
    lang: 'rust',
    source: 'src-tauri/src/services/',
    forbidRust: ['crate::commands'],
    reason: 'a service is called by the command layer; it never knows the IPC surface exists',
  },
  {
    id: 'rust-models-not-commands',
    lang: 'rust',
    source: 'src-tauri/src/models/',
    forbidRust: ['crate::commands'],
    reason: 'DTOs and event models are shared by both sides of IPC; they cannot depend on one',
  },
]

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const RUST_EXTENSIONS = new Set(['.rs'])

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((entry) => entry !== '')
}

/** Module specifiers in one TypeScript file, including re-exports and dynamic `import()`. */
function importsOf(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const specifiers = []
  const add = (specifier) => {
    if (typeof specifier === 'string') specifiers.push(specifier)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteral(argument)) add(argument.text)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** A repository path for a relative or `@/` specifier, or `null` for a package import. */
function resolveSpecifier(fromFile, specifier) {
  let base
  if (specifier.startsWith('@/')) base = `src/src/${specifier.slice(2)}`
  else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier)
  else return null
  base = path.posix.normalize(base)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((candidate) => existsSync(path.join(ROOT, candidate))) ?? base
}

const under = (candidate, prefix) => candidate === prefix || candidate.startsWith(prefix)

/**
 * Every `crate::` first segment a Rust file's `use` statements name.
 *
 * `use crate::{commands, services::validate::{a, b}}` names two top-level modules; the walk splits
 * the brace groups at their own depth so a nested tree does not lose the outer name.
 */
function rustCrateUses(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const segments = new Set()
  const useStatement = /\buse\s+([^;]+);/g
  for (const match of stripped.matchAll(useStatement)) {
    collect(match[1], segments)
  }
  return [...segments]
}

function collect(tree, segments) {
  const marker = /crate\s*::\s*/g
  for (const match of tree.matchAll(marker)) {
    const rest = tree.slice(match.index + match[0].length).trimStart()
    if (rest.startsWith('{')) {
      for (const item of splitTopLevel(rest.slice(1, matchingBrace(rest)))) {
        const identifier = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(item)
        if (identifier) segments.add(`crate::${identifier[1]}`)
      }
      continue
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (identifier) segments.add(`crate::${identifier[0]}`)
  }
}

/** Index of the `}` matching the `{` at index 0 of `text`, or the end of the text. */
function matchingBrace(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return text.length
}

/** Comma-separated items of a brace body, respecting nested braces. */
function splitTopLevel(text) {
  const items = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') depth -= 1
    else if (text[index] === ',' && depth === 0) {
      items.push(text.slice(start, index))
      start = index + 1
    }
  }
  items.push(text.slice(start))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

const allowlistPath = path.join(ROOT, ALLOWLIST)
if (!existsSync(allowlistPath)) throw new Error(`${ALLOWLIST} is missing`)
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const pinned = new Set(allowlist.entries ?? [])

const violations = []
const seen = new Set()
let scanned = 0

for (const file of trackedFiles()) {
  const extension = path.extname(file).toLowerCase()
  const rule = RULES.find((candidate) => under(file, candidate.source))
  if (!rule) continue
  const languageMatches =
    (rule.lang === 'ts' && CODE_EXTENSIONS.has(extension)) ||
    (rule.lang === 'rust' && RUST_EXTENSIONS.has(extension))
  if (!languageMatches) continue
  if (!existsSync(path.join(ROOT, file))) continue
  scanned += 1

  const text = readFileSync(path.join(ROOT, file), 'utf8')
  const targets =
    rule.lang === 'rust'
      ? rustCrateUses(text).map((target) => ({ target, specifier: target }))
      : importsOf(file, text)
          .filter((specifier) => specifier.startsWith('.') || specifier.startsWith('@/'))
          .map((specifier) => ({ target: resolveSpecifier(file, specifier), specifier }))

  for (const { target, specifier } of targets) {
    let broken = false
    if (rule.lang === 'rust') {
      broken = (rule.forbidRust ?? []).some((prefix) => under(target, prefix))
    } else if (rule.allowRepo) {
      broken = !rule.allowRepo.some((prefix) => under(target, prefix))
    } else if (rule.forbidRepo) {
      broken = rule.forbidRepo.some((prefix) => under(target, prefix))
    }
    if (!broken) continue

    const key = `${rule.id}|${file}|${specifier}`
    if (pinned.has(key)) {
      seen.add(key)
      continue
    }
    violations.push({
      key,
      message: `${rule.id}: ${file} imports ${specifier} (${target}) — ${rule.reason}`,
    })
  }
}

for (const entry of pinned) {
  if (!seen.has(entry)) {
    violations.push({
      key: entry,
      message: `${ALLOWLIST}: stale entry "${entry}" — the edge is gone; delete it so it cannot reappear unnoticed`,
    })
  }
}

if (violations.length > 0) {
  console.error(`\narchitecture: ${violations.length} violation(s)`)
  for (const violation of violations) console.error(`  - ${violation.message}`)
  process.exit(1)
}
console.log(
  `\narchitecture: ${scanned} file(s) against ${RULES.length} rule(s), ${pinned.size} pinned edge(s)`,
)

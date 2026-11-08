/**
 * What a tag or extension means to the highlighter.
 *
 * This module is the main thread's half of the grammar table, and it deliberately contains no
 * grammar loaders: `code-language-loaders.ts` (worker-only) owns those. The split matters because
 * every `import('shiki/langs/…')` is a chunk, and the fence resolver on the main thread must not
 * drag the whole grammar set into the application bundle just to read this table.
 *
 * A model writes `js`, `rs`, `py`, `sh`; a file is named `.tsx`, `.yml`, `.bash`. Resolving those
 * to a canonical grammar here means the worker, the fence resolver and the file header cannot
 * drift apart. Every other tag is drawn as plain text exactly as before.
 */

/**
 * Extra spellings per grammar. The keys are the canonical shiki ids this build ships — the worker's
 * loader table is typed as `Record<CodeLanguage, …>`, so adding a language here without a loader
 * (or the reverse) fails typecheck.
 */
const ALIASES = {
  typescript: ['ts', 'mts', 'cts'],
  tsx: [],
  javascript: ['js', 'mjs', 'cjs'],
  jsx: [],
  json: ['jsonc', 'json5'],
  markdown: ['md', 'mdx'],
  css: [],
  scss: [],
  sass: [],
  less: [],
  html: ['htm'],
  vue: [],
  svelte: [],
  rust: ['rs'],
  go: [],
  c: ['h'],
  cpp: ['c++', 'cc', 'cxx', 'hpp', 'hh'],
  csharp: ['cs', 'c#'],
  java: [],
  kotlin: ['kt', 'kts'],
  swift: [],
  dart: [],
  lua: [],
  ruby: ['rb'],
  php: [],
  python: ['py', 'pyi'],
  perl: ['pl', 'pm'],
  r: [],
  scala: [],
  elixir: ['ex', 'exs'],
  shellscript: ['bash', 'sh', 'shell', 'zsh'],
  powershell: ['ps1', 'psm1', 'pwsh'],
  fish: [],
  bat: ['batch', 'cmd'],
  yaml: ['yml'],
  toml: [],
  ini: ['cfg', 'conf', 'properties'],
  dotenv: ['env'],
  xml: [],
  sql: [],
  diff: ['patch'],
  docker: ['dockerfile'],
  make: ['makefile', 'justfile'],
  graphql: ['gql'],
  proto: ['protobuf'],
  hcl: ['tf', 'tfvars', 'terraform'],
  cmake: [],
  nginx: [],
  prisma: [],
  haskell: ['hs', 'lhs'],
  ocaml: ['ml', 'mli'],
  clojure: ['clj', 'cljs', 'cljc', 'edn'],
  julia: ['jl'],
  zig: [],
  'objective-c': ['m', 'mm', 'objc'],
  erlang: ['erl', 'hrl'],
  groovy: ['gradle'],
  nix: [],
  solidity: ['sol'],
  asm: ['assembly', 's', 'nasm'],
  latex: ['tex', 'sty'],
  astro: [],
  csv: ['tsv'],
  mermaid: ['mmd'],
  'fortran-fixed-form': ['fortran-fixed', 'f', 'for'],
  'fortran-free-form': ['fortran', 'f90', 'f95', 'f03', 'f08'],
} as const satisfies Record<string, readonly string[]>

export type CodeLanguage = keyof typeof ALIASES

/** `text` is not a grammar: it is the instruction to draw the source uncoloured. */
export type AgentCodeLanguage = CodeLanguage | 'text'

/**
 * Tag → grammar, built once. A plain object rather than a Map because the table is static; lookups
 * go through `Object.hasOwn` so inherited keys (`constructor`, `toString`) are not grammars.
 */
const TAG_TO_LANGUAGE: Record<string, CodeLanguage> = {}
for (const id of Object.keys(ALIASES) as CodeLanguage[]) {
  TAG_TO_LANGUAGE[id] = id
  for (const alias of ALIASES[id]) TAG_TO_LANGUAGE[alias] = id
}

const hasOwn = Object.prototype.hasOwnProperty

/** A canonical grammar for a tag or extension, or `null` when this build does not ship it. */
export function resolveCodeLanguage(tag: string): CodeLanguage | null {
  const key = tag.trim().toLowerCase()
  return hasOwn.call(TAG_TO_LANGUAGE, key) ? TAG_TO_LANGUAGE[key]! : null
}

export interface AgentCodeToken {
  content: string
  offset: number
  light?: string
  dark?: string
}

export type AgentCodeTokenLines = AgentCodeToken[][]

/**
 * What the worker is asked to do.
 *
 * `highlight` is the only one whose answer anyone draws; `warm` (create the highlighter: themes and
 * the oniguruma wasm) and `prefetch` (load one grammar) exist so a file's colours are ready before
 * the text arrives. Both are fire-and-forget: their answers carry `lines: null` and are ignored.
 */
export type CodeHighlightJob =
  | { kind: 'highlight'; code: string; language: AgentCodeLanguage; maxChars: number }
  | { kind: 'warm' }
  | { kind: 'prefetch'; language: AgentCodeLanguage }

export type CodeHighlightRequest = CodeHighlightJob & { id: number }

export interface CodeHighlightResponse {
  id: number
  /** `null` means "draw it plain": unknown grammar, over the bound, or tokenization failed. */
  lines: AgentCodeTokenLines | null
}

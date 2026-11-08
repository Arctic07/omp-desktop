/**
 * What the file tree and the preview know about one path before anything is read.
 *
 * The icon and the colour are the tree's own vocabulary; the language is what the preview asks
 * shiki for. Both come from the leaf name, so this module is pure and shared by the two surfaces.
 */

import {
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  Lock,
  type LucideIcon,
} from 'lucide-react'

import type { AgentCodeLanguage } from '@/components/agents/code-language'
import { fileLeafName } from '@/lib/file-path'

type FileFamily = 'code' | 'json' | 'config' | 'text' | 'image' | 'terminal' | 'lock' | 'plain'

export interface FileDisplay {
  language: AgentCodeLanguage
  icon: LucideIcon
  iconClassName: string
  /** The short tag the preview header shows; `text` for anything without a grammar. */
  languageLabel: string
}

const FAMILY: Record<
  FileFamily,
  { icon: LucideIcon; iconClassName: string }
> = {
  code: { icon: FileCode2, iconClassName: 'text-sky-500' },
  json: { icon: FileJson, iconClassName: 'text-amber-500' },
  config: { icon: FileCog, iconClassName: 'text-orange-400' },
  text: { icon: FileText, iconClassName: 'text-muted-foreground' },
  image: { icon: FileImage, iconClassName: 'text-violet-400' },
  terminal: { icon: FileTerminal, iconClassName: 'text-emerald-500' },
  lock: { icon: Lock, iconClassName: 'text-rose-400' },
  plain: { icon: File, iconClassName: 'text-muted-foreground' },
}

function display(
  family: FileFamily,
  language: AgentCodeLanguage,
  languageLabel = language === 'text' ? 'text' : language,
): FileDisplay {
  return { ...FAMILY[family], language, languageLabel }
}

/** An image has no grammar; the header still names what it is rather than saying `text`. */
const IMAGE = display('image', 'text', 'image')

/** Extension → grammar + family. Keys are lower case and never include the dot. */
const BY_EXTENSION: Record<string, FileDisplay> = {
  ts: display('code', 'typescript'),
  mts: display('code', 'typescript'),
  cts: display('code', 'typescript'),
  tsx: display('code', 'tsx'),
  js: display('code', 'javascript'),
  mjs: display('code', 'javascript'),
  cjs: display('code', 'javascript'),
  jsx: display('code', 'jsx'),
  json: display('json', 'json'),
  jsonc: display('json', 'json'),
  json5: display('json', 'json'),
  jsonl: display('json', 'json'),
  ndjson: display('json', 'json'),
  geojson: display('json', 'json'),
  webmanifest: display('json', 'json'),
  md: display('text', 'markdown'),
  mdx: display('text', 'markdown'),
  csv: display('text', 'csv'),
  tsv: display('text', 'csv'),
  hs: display('code', 'haskell'),
  lhs: display('code', 'haskell'),
  ml: display('code', 'ocaml'),
  mli: display('code', 'ocaml'),
  clj: display('code', 'clojure'),
  cljs: display('code', 'clojure'),
  cljc: display('code', 'clojure'),
  edn: display('text', 'clojure'),
  jl: display('code', 'julia'),
  zig: display('code', 'zig'),
  m: display('code', 'objective-c'),
  mm: display('code', 'objective-c'),
  erl: display('code', 'erlang'),
  hrl: display('code', 'erlang'),
  groovy: display('code', 'groovy'),
  gradle: display('code', 'groovy'),
  nix: display('config', 'nix'),
  sol: display('code', 'solidity'),
  asm: display('code', 'asm'),
  s: display('code', 'asm'),
  tex: display('text', 'latex'),
  sty: display('text', 'latex'),
  astro: display('code', 'astro'),
  mmd: display('text', 'mermaid'),
  mermaid: display('text', 'mermaid'),
  f: display('code', 'fortran-fixed-form'),
  for: display('code', 'fortran-fixed-form'),
  ftn: display('code', 'fortran-fixed-form'),
  f90: display('code', 'fortran-free-form'),
  f95: display('code', 'fortran-free-form'),
  f03: display('code', 'fortran-free-form'),
  f08: display('code', 'fortran-free-form'),
  css: display('code', 'css'),
  scss: display('code', 'scss'),
  sass: display('code', 'sass'),
  less: display('code', 'less'),
  html: display('code', 'html'),
  htm: display('code', 'html'),
  vue: display('code', 'vue'),
  svelte: display('code', 'svelte'),
  rs: display('code', 'rust'),
  go: display('code', 'go'),
  py: display('code', 'python'),
  pyi: display('code', 'python'),
  rb: display('code', 'ruby'),
  java: display('code', 'java'),
  kt: display('code', 'kotlin'),
  kts: display('code', 'kotlin'),
  cs: display('code', 'csharp'),
  php: display('code', 'php'),
  swift: display('code', 'swift'),
  c: display('code', 'c'),
  h: display('code', 'c'),
  cc: display('code', 'cpp'),
  cpp: display('code', 'cpp'),
  cxx: display('code', 'cpp'),
  hpp: display('code', 'cpp'),
  hh: display('code', 'cpp'),
  lua: display('code', 'lua'),
  dart: display('code', 'dart'),
  ex: display('code', 'elixir'),
  exs: display('code', 'elixir'),
  scala: display('code', 'scala'),
  pl: display('code', 'perl'),
  pm: display('code', 'perl'),
  r: display('code', 'r'),
  sh: display('terminal', 'shellscript', 'bash'),
  bash: display('terminal', 'shellscript', 'bash'),
  zsh: display('terminal', 'shellscript', 'zsh'),
  fish: display('terminal', 'fish'),
  ps1: display('terminal', 'powershell'),
  psm1: display('terminal', 'powershell'),
  bat: display('terminal', 'bat', 'batch'),
  cmd: display('terminal', 'bat', 'batch'),
  sql: display('code', 'sql'),
  yml: display('config', 'yaml'),
  yaml: display('config', 'yaml'),
  toml: display('config', 'toml'),
  ini: display('config', 'ini'),
  cfg: display('config', 'ini'),
  conf: display('config', 'ini'),
  properties: display('config', 'ini'),
  xml: display('code', 'xml'),
  graphql: display('code', 'graphql'),
  gql: display('code', 'graphql'),
  proto: display('config', 'proto'),
  prisma: display('code', 'prisma'),
  hcl: display('config', 'hcl'),
  tf: display('config', 'hcl'),
  tfvars: display('config', 'hcl'),
  cmake: display('config', 'cmake'),
  svg: IMAGE,
  diff: display('code', 'diff'),
  patch: display('code', 'diff'),
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  ico: IMAGE,
  bmp: IMAGE,
  avif: IMAGE,
  lock: display('lock', 'text'),
  log: display('text', 'text'),
  txt: display('text', 'text'),
}

/** Whole-name files whose meaning is not in an extension. */
const BY_NAME: Record<string, FileDisplay> = {
  dockerfile: display('config', 'docker'),
  makefile: display('config', 'make'),
  justfile: display('config', 'make'),
  'cmakelists.txt': display('config', 'cmake'),
  'nginx.conf': display('config', 'nginx'),
  'package.json': display('json', 'json'),
  'tsconfig.json': display('json', 'json'),
  'tsconfig.app.json': display('json', 'json'),
  'tsconfig.node.json': display('json', 'json'),
  'pnpm-lock.yaml': display('lock', 'yaml'),
  'package-lock.json': display('lock', 'json'),
  'yarn.lock': display('lock', 'text'),
  'cargo.toml': display('config', 'toml'),
  'cargo.lock': display('lock', 'toml'),
  'go.mod': display('config', 'go'),
  'go.sum': display('lock', 'text'),
  '.gitignore': display('text', 'text'),
  '.gitattributes': display('text', 'text'),
  '.editorconfig': display('config', 'ini'),
  '.env': display('config', 'dotenv'),
  '.envrc': display('terminal', 'shellscript', 'bash'),
  '.dockerignore': display('text', 'text'),
  license: display('text', 'text'),
  'license.md': display('text', 'markdown'),
  readme: display('text', 'markdown'),
  'readme.md': display('text', 'markdown'),
}

const hasOwn = Object.prototype.hasOwnProperty

export function describeFile(path: string): FileDisplay {
  const leaf = fileLeafName(path)
  const lower = leaf.toLowerCase()
  const byName = hasOwn.call(BY_NAME, lower) ? BY_NAME[lower] : undefined
  if (byName !== undefined) return byName

  // A dotfile's meaning is often in its leading name, not its last dot: `.env.local` and
  // `Dockerfile.dev` have no extension this table could name, and `local`/`dev` mean nothing.
  if (lower.startsWith('.env.')) {
    return display('config', 'dotenv')
  }
  if (lower.startsWith('dockerfile') || lower.endsWith('.dockerfile')) {
    return display('config', 'docker')
  }

  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return display('plain', 'text')
  const extension = lower.slice(dot + 1)
  return hasOwn.call(BY_EXTENSION, extension)
    ? BY_EXTENSION[extension]!
    : display('plain', 'text')
}

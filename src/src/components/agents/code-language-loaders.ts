/**
 * The worker's grammar table: one dynamic import per language this build ships.
 *
 * Kept out of `code-language.ts` on purpose. That module is imported by the main thread's fence
 * resolver, and if the loaders lived there the bundler would emit (and preload) every grammar chunk
 * for a surface that never tokenizes anything. Only the worker imports this file, so the grammar
 * assets belong to the worker's own module graph.
 *
 * The full shiki bundle is ~630 grammars; this is the mainstream set the UI can actually name.
 * Adding a language means adding one loader here and its aliases in `code-language.ts`.
 */

import type { LanguageRegistration } from 'shiki/core'

import type { CodeLanguage } from './code-language'

export type GrammarModule = { default: LanguageRegistration[] }

export const CODE_LANGUAGES: Record<CodeLanguage, () => Promise<GrammarModule>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sass: () => import('shiki/langs/sass.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  ocaml: () => import('shiki/langs/ocaml.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  solidity: () => import('shiki/langs/solidity.mjs'),
  asm: () => import('shiki/langs/asm.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  mermaid: () => import('shiki/langs/mermaid.mjs'),
  'fortran-fixed-form': () => import('shiki/langs/fortran-fixed-form.mjs'),
  'fortran-free-form': () => import('shiki/langs/fortran-free-form.mjs'),
}

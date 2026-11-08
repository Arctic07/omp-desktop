import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { seedNativeSkill } from './native-skill.ts'

/**
 * The rule a built-in recipe is seeded by: it tracks the build, and it never takes a reader's edit.
 *
 * The four branches are the whole contract - a fresh root, an untouched copy from an older build, a
 * copy the reader edited, and a file nobody marked - and each one is a decision about *whose* bytes
 * win. The wording of any recipe is not this file's business; these tests use throwaway bodies.
 */

const BODY = '---\nname: recipe\ndescription: one\n---\n\nfirst build\n'
const NEWER = '---\nname: recipe\ndescription: two\n---\n\nsecond build, with a new capability\n'

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omp-native-skill-'))
}

function recipeIn(agentDir: string): string {
  return path.join(agentDir, 'skills', 'recipe', 'SKILL.md')
}

test('a fresh data root gets the recipe and the marker that names it', () => {
  const agentDir = freshRoot()
  seedNativeSkill(agentDir, { name: 'recipe', body: BODY })
  const written = fs.readFileSync(recipeIn(agentDir), 'utf8')
  assert.ok(written.startsWith(BODY), 'the body is there whole')
  assert.match(written, /\n<!-- omp-desktop-seed:[0-9a-f]{64} -->\n$/, 'one marker line at the end')
})

test('a copy nobody has edited is refreshed to this build', () => {
  const agentDir = freshRoot()
  seedNativeSkill(agentDir, { name: 'recipe', body: BODY })

  seedNativeSkill(agentDir, { name: 'recipe', body: NEWER })

  const written = fs.readFileSync(recipeIn(agentDir), 'utf8')
  assert.ok(
    written.startsWith(NEWER),
    'a capability change reaches a machine that already ran the previous build',
  )
  assert.ok(!fs.existsSync(`${recipeIn(agentDir)}.superseded`), 'nothing was set aside')
})

test('a copy the reader edited is left exactly as it is', () => {
  const agentDir = freshRoot()
  seedNativeSkill(agentDir, { name: 'recipe', body: BODY })
  const file = recipeIn(agentDir)
  // What a real edit looks like: the reader changes the body and the marker that came with it stays.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('first build', 'my own words'), 'utf8')
  const edited = fs.readFileSync(file, 'utf8')

  seedNativeSkill(agentDir, { name: 'recipe', body: NEWER })

  assert.equal(fs.readFileSync(file, 'utf8'), edited, 'not one byte moved')
})

test('a file with no marker is adopted, and its bytes are kept beside it', () => {
  const agentDir = freshRoot()
  const file = recipeIn(agentDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // A copy from a build that predates marking, or a recipe the reader wrote under this name: the two
  // cannot be told apart, so the built-in wins and the bytes survive under a name that says so.
  fs.writeFileSync(file, '---\nname: recipe\n---\n\nfrom before marking\n', 'utf8')

  seedNativeSkill(agentDir, { name: 'recipe', body: NEWER })

  assert.ok(fs.readFileSync(file, 'utf8').startsWith(NEWER), 'this build owns the name')
  assert.equal(
    fs.readFileSync(`${file}.superseded`, 'utf8'),
    '---\nname: recipe\n---\n\nfrom before marking\n',
    'the copy that was there is intact',
  )
})

test('a second start with the same body writes nothing at all', () => {
  const agentDir = freshRoot()
  seedNativeSkill(agentDir, { name: 'recipe', body: BODY })
  const file = recipeIn(agentDir)
  const before = fs.statSync(file).mtimeMs
  seedNativeSkill(agentDir, { name: 'recipe', body: BODY })
  assert.equal(fs.statSync(file).mtimeMs, before, 'an identical body is not rewritten')
})

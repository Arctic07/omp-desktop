import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveFenceLanguage } from './fence-language.ts'

/**
 * A fence tag is the model's own word, and every word has to land somewhere.
 *
 * What is pinned down here is the resolution `markdown.tsx` draws by: the grammar a tag names (by
 * id or by an alias the model is far more likely to write), and the tag the header repeats. A fence
 * with no grammar is the case that used to fall out of the renderer entirely — it must still be a
 * code block, drawn as plain text.
 */

test('a canonical grammar id resolves to itself', () => {
  assert.deepEqual(resolveFenceLanguage('typescript'), {
    language: 'typescript',
    label: 'typescript',
  })
})

test('the aliases a model actually writes resolve to their grammar', () => {
  // `js` and `py` are the spellings of a conversation; `javascript` and `python` are their ids.
  assert.equal(resolveFenceLanguage('js').language, 'javascript')
  assert.equal(resolveFenceLanguage('py').language, 'python')
  assert.equal(resolveFenceLanguage('rs').language, 'rust')
  assert.equal(resolveFenceLanguage('yml').language, 'yaml')
  // Several tags name one grammar, so the header's label and the grammar part company.
  assert.deepEqual(resolveFenceLanguage('sh'), { language: 'shellscript', label: 'sh' })
})

test('the tag is read case-insensitively but stated as written', () => {
  assert.deepEqual(resolveFenceLanguage('JSON'), { language: 'json', label: 'JSON' })
  assert.equal(resolveFenceLanguage('  Bash ').language, 'shellscript')
})

test('a tag no grammar answers stays a code block, in plain text', () => {
  // `text` is the one tag a model writes to say "no language at all"; a tool's own invented tag is
  // the other. Neither is a grammar, and both keep the block.
  assert.deepEqual(resolveFenceLanguage('text'), { language: 'text', label: 'text' })
  assert.deepEqual(resolveFenceLanguage('no-such-grammar'), {
    language: 'text',
    label: 'no-such-grammar',
  })
})

test('an empty tag is a fence with no name', () => {
  assert.deepEqual(resolveFenceLanguage(''), { language: 'text', label: '' })
})

test('an inherited object key is not a grammar', () => {
  // The lookup table is a plain object, and `constructor` / `toString` are its prototype's keys.
  assert.equal(resolveFenceLanguage('constructor').language, 'text')
  assert.equal(resolveFenceLanguage('toString').language, 'text')
})

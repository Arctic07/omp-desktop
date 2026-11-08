import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCleanseArgs } from './cleanse.ts'

/**
 * `/cleanse`'s flags, parsed the way the CLI's own command parses them.
 *
 * The run itself is the engine's (`cleanse/index.ts`); what can be wrong on this side is the
 * mapping from a command line to its options, and a typo must be an error rather than a request
 * with a strange name.
 */

test('a bare /cleanse runs every checker', () => {
  assert.deepEqual(parseCleanseArgs(''), {
    all: false,
    maxAgents: undefined,
    model: undefined,
    includeTests: false,
    request: undefined,
  })
})

test('flags and a free-form request are separated', () => {
  assert.deepEqual(parseCleanseArgs('--all --agents 4 --model opus --tests ts errors'), {
    all: true,
    maxAgents: 4,
    model: 'opus',
    includeTests: true,
    request: 'ts errors',
  })
})

test('a request may be a single quoted sentence', () => {
  const parsed = parseCleanseArgs('"fix the type errors"')
  assert.equal(typeof parsed === 'string' ? parsed : parsed.request, 'fix the type errors')
})

test('an unusable agent count or a missing model is an error, not a request', () => {
  assert.equal(parseCleanseArgs('--agents 0'), '--agents must be a positive integer.')
  assert.equal(parseCleanseArgs('--agents nope'), '--agents must be a positive integer.')
  assert.equal(parseCleanseArgs('--model'), '--model needs a model name.')
})

test('--key=value is accepted for both valued flags', () => {
  const parsed = parseCleanseArgs('--agents=2 --model=openai/gpt-5')
  assert.equal(typeof parsed, 'object')
  if (typeof parsed === 'string') return
  assert.equal(parsed.maxAgents, 2)
  assert.equal(parsed.model, 'openai/gpt-5')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UiFormChoice, UiFormText } from '@/api/session-types'
import { answersOf, draftError, initialDraft, isGroup } from './form-draft.ts'

/**
 * The `ask` form's submit gate, its draft, and the answers that leave it.
 *
 * The engine's own reader parses the form and owns the document; the host owns what shape each
 * answer takes. What the window owns is the draft a reader edits and the gate that decides whether a
 * submit happens at all - so these are the two rules tested here.
 */

function choice(overrides: Partial<UiFormChoice> = {}): UiFormChoice {
  return {
    kind: 'choice',
    name: 'store',
    multi: false,
    select: false,
    other: false,
    label: [],
    options: [
      { value: 'sqlite', label: 'SQLite', checked: true, disabled: false },
      { value: 'redis', label: 'Redis', checked: false, disabled: false },
    ],
    required: false,
    ...overrides,
  }
}

function text(overrides: Partial<UiFormText> = {}): UiFormText {
  return {
    kind: 'text',
    name: 'ttl',
    type: 'text',
    multiline: false,
    label: [],
    value: '',
    placeholder: '',
    required: false,
    rows: 1,
    ...overrides,
  }
}

/** A form opens on the model's recommendation, which is also what a timeout submits. */
test('a draft opens on the form preselection', () => {
  const draft = initialDraft([choice(), text({ value: '30' })])
  assert.deepEqual(draft, { store: 'sqlite', ttl: '30' })
})

/** A checkbox group opens on every option the model checked, not just the first. */
test('a checkbox group opens on all its checked options', () => {
  const group = choice({
    name: 'tags',
    multi: true,
    options: [
      { value: 'a', label: 'A', checked: true, disabled: false },
      { value: 'b', label: 'B', checked: true, disabled: false },
    ],
  })
  assert.deepEqual(initialDraft([group]), { tags: ['a', 'b'] })
})

/**
 * A lone checkbox is `multi` in the parsed form, but the engine reports its value as a scalar
 * (`isArrayChoice` is `multi && options.length > 1`). The draft has to agree, or the control is
 * drawn as a one-item group and the answer travels in the wrong shape.
 */
test('a lone checkbox opens as a scalar, not a one-item group', () => {
  const lone = choice({
    name: 'agree',
    multi: true,
    options: [{ value: 'on', label: 'Agree', checked: true, disabled: false }],
  })
  assert.equal(isGroup(lone), false)
  assert.deepEqual(initialDraft([lone]), { agree: 'on' })
})

/** A multi-select is a group: its answer is an array, and the control must be drawn as one. */
test('a multi-select is a group', () => {
  const multiSelect = choice({ name: 'tags', multi: true, select: true })
  assert.equal(isGroup(multiSelect), true)
  assert.deepEqual(initialDraft([multiSelect]), { tags: ['sqlite'] })
})

/** A required field blocks the submit; an optional empty one does not. */
test('a required field blocks a submit and an optional one does not', () => {
  assert.equal(draftError(choice({ required: true }), '')?.reason, 'required')
  assert.equal(draftError(choice({ required: false }), ''), undefined)
  assert.equal(draftError(text({ required: true }), '  ')?.reason, 'required')
  assert.equal(draftError(text({ required: false }), ''), undefined)
})

/** The numeric bounds the model was told it set are enforced, and the reason names the bound. */
test('numeric bounds are enforced and carry the bound', () => {
  const field = text({ type: 'number', min: 1, max: 10 })
  assert.deepEqual(draftError(field, '0'), { reason: 'min', bound: 1 })
  assert.deepEqual(draftError(field, '11'), { reason: 'max', bound: 10 })
  assert.equal(draftError(field, '5'), undefined)
  assert.equal(draftError(field, 'abc')?.reason, 'number')
})

/** `pattern` is anchored the way HTML anchors it, and an invalid one is ignored rather than fatal. */
test('a pattern is anchored and an invalid one is ignored', () => {
  const field = text({ pattern: '[a-z]+' })
  assert.equal(draftError(field, 'abc'), undefined)
  assert.equal(draftError(field, 'abc1')?.reason, 'pattern')
  // `(` alone is not a valid expression: HTML ignores it, and so does this gate.
  assert.equal(draftError(text({ pattern: '(' }), 'anything'), undefined)
})

/**
 * A pathological pattern must not be compiled: a backtracking expression over long input freezes the
 * renderer, and the pattern is agent-written. Beyond either cap the pattern is ignored, exactly as
 * an invalid one is.
 */
test('an oversized pattern or value is not tested', () => {
  const hugePattern = text({ pattern: `${'a'.repeat(600)}` })
  assert.equal(draftError(hugePattern, 'zzz'), undefined)
  const shortPattern = text({ pattern: '[a-z]+' })
  assert.equal(draftError(shortPattern, 'z'.repeat(5_000)), undefined)
})

/**
 * Every field the reader touched travels, including one they **emptied**: clearing a prefilled field
 * is an answer, and omitting it would let the host fill the model's own recommendation back in.
 *
 * The shape is not decided here - the host applies the engine's `isArrayChoice`/`textValue` - so a
 * group and a text field both send the draft exactly as the control holds it.
 */
test('every touched field travels, emptied ones included', () => {
  const fields = [choice(), text({ value: '30' })]
  assert.deepEqual(answersOf(fields, { store: 'redis', ttl: '' }), [
    { name: 'store', value: 'redis' },
    { name: 'ttl', value: '' },
  ])
})

/** A group sends its checked values as an array, which is what the control holds. */
test('a group sends the values it holds', () => {
  const group = choice({ name: 'tags', multi: true })
  assert.deepEqual(answersOf([group], { tags: ['a', 'b'] }), [
    { name: 'tags', value: ['a', 'b'] },
  ])
  assert.deepEqual(answersOf([group], { tags: [] }), [{ name: 'tags', value: [] }])
})

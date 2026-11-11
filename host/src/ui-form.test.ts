import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as htmlFormData from '@oh-my-pi/pi-tui/html-form/data'
import { type ChoiceField, parseHtmlForm } from '@oh-my-pi/pi-tui/html-form/parse'

import { formResponseData, wireForm } from './ui-form.ts'

/** The two value rules the engine owns, wired the way `sdk.ts` wires them. */
const isArrayChoice = htmlFormData.isArrayChoice
const textValue = htmlFormData.textValue

/**
 * The `ask` tool's form, from the engine's HTML to the wire and back.
 *
 * Since engine 18.18.3 the tool asks with one `<form>` and reads back `HtmlFormData`. The host owns
 * neither end of that contract - the parser and the value rules are the engine's own - so what is
 * tested here is only the projection: that a parsed form keeps its document shape on the wire, that
 * a picture the window cannot load degrades to its alt text rather than to a file read, and that an
 * answer names the controls the form actually has.
 */

const FORM = `<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
  <label>Lifetime <input type="number" name="ttl" value="30" min="1"></label>
</form>`

test('a parsed form keeps its sections, context and fields on the wire', () => {
  const form = parseHtmlForm(FORM)
  const wire = wireForm(form)

  assert.equal(wire.sections.length, form.sections.length)
  assert.deepEqual(
    wire.fields.map(field => field.name),
    ['store', 'ttl'],
  )
  // The paragraph before the fieldset is context the reader needs to decide: it must survive.
  const context = wire.sections.flatMap(section => section.blocks).find(block => block.kind === 'text')
  assert.equal(context?.kind, 'text')
  assert.equal(context.kind === 'text' ? context.spans.map(span => span.text).join('') : '', 'Sessions live in memory and are lost on restart.')

  const choice = wire.fields[0]
  assert.equal(choice?.kind, 'choice')
  assert.equal(choice.kind === 'choice' ? choice.options.length : 0, 2)
  // The preselection is the model's recommendation, and what a timeout submits.
  assert.deepEqual(
    choice.kind === 'choice' ? choice.options.filter(option => option.checked).map(option => option.value) : [],
    ['sqlite'],
  )

  const text = wire.fields[1]
  assert.equal(text?.kind, 'text')
  assert.equal(text.kind === 'text' ? text.min : undefined, 1)
  assert.equal(text.kind === 'text' ? text.value : undefined, '30')
})

/**
 * A picture the window can load travels as an image; one it cannot travels as its alt text.
 *
 * A local path would have to become a file-read capability for the webview to draw it, and the form
 * surface has no business adding one - so the reader gets the words the model wrote for the picture
 * instead of a broken frame.
 */
test('only a self-loading picture source stays an image', () => {
  const wire = wireForm(
    parseHtmlForm(`<form>
      <img src="https://example.test/chart.png" alt="Remote">
      <img src="data:image/png;base64,AAAA" alt="Inline">
      <img src="docs/arch.png" alt="Local diagram">
      <input type="text" name="note">
    </form>`),
  )
  const blocks = wire.sections.flatMap(section => section.blocks)
  const images = blocks.filter(block => block.kind === 'image')
  assert.deepEqual(
    images.map(block => (block.kind === 'image' ? block.src : '')),
    ['https://example.test/chart.png', 'data:image/png;base64,AAAA'],
  )
  const local = blocks.find(block => block.kind === 'text')
  assert.equal(local?.kind, 'text')
  assert.equal(local.kind === 'text' ? local.spans.map(span => span.text).join('') : '', 'Local diagram')
})

/**
 * An answer names the controls the form has. A name the form does not carry is dropped rather than
 * forwarded: the engine validates the data against the form it parsed, so an invented control is an
 * answer nothing asked for.
 */
test('an answer keeps the form defaults and drops unknown controls', () => {
  const form = parseHtmlForm(FORM)
  const defaults = htmlFormData.defaultFormData(form)
  assert.deepEqual(defaults, { store: 'sqlite', ttl: 30 })

  const data = formResponseData(
    form,
    defaults,
    [
      { name: 'store', value: 'redis' },
      { name: 'invented', value: 'x' },
    ],
    isArrayChoice,
    textValue,
  )
  assert.deepEqual(data, { store: 'redis', ttl: 30 })
})

/** A value of the wrong shape for its field is dropped, never coerced into one the reader did not give. */
test('a value of the wrong shape for its field is dropped', () => {
  const form = parseHtmlForm(FORM)
  const defaults = htmlFormData.defaultFormData(form)
  const data = formResponseData(
    form,
    defaults,
    [
      { name: 'store', value: ['redis', 'sqlite'] },
      { name: 'ttl', value: ['30'] },
    ],
    isArrayChoice,
    textValue,
  )
  assert.deepEqual(data, defaults)
})

/** A checkbox group answers as an array, which is the shape the tool reports to the model. */
test('a checkbox group answers as an array', () => {
  const form = parseHtmlForm(
    `<form><label><input type="checkbox" name="tags" value="a" checked> A</label>
     <label><input type="checkbox" name="tags" value="b"> B</label></form>`,
  )
  const defaults = htmlFormData.defaultFormData(form)
  const data = formResponseData(form, defaults, [{ name: 'tags', value: ['a', 'b'] }], isArrayChoice, textValue)
  assert.deepEqual(data, { tags: ['a', 'b'] })
})

/**
 * A **lone** checkbox is `multi` in the parsed form but reports a scalar (`isArrayChoice` is
 * `multi && options.length > 1`). Sending it as an array would be a value the engine drops, so the
 * reader's tick would silently vanish.
 */
test('a lone checkbox answers as a scalar', () => {
  const form = parseHtmlForm(`<form><label><input type="checkbox" name="agree"> Agree</label></form>`)
  const defaults = htmlFormData.defaultFormData(form)
  assert.equal(htmlFormData.isArrayChoice(form.fields[0] as ChoiceField), false)

  const ticked = formResponseData(form, defaults, [{ name: 'agree', value: 'on' }], isArrayChoice, textValue)
  assert.deepEqual(ticked, { agree: 'on' })

  // The array shape for the same field is refused rather than coerced.
  const wrong = formResponseData(form, defaults, [{ name: 'agree', value: ['on'] }], isArrayChoice, textValue)
  assert.deepEqual(wrong, {})
})

/** A `<select multiple>` reports an array, so a scalar answer for it is refused. */
test('a multi-select answers as an array', () => {
  const form = parseHtmlForm(
    `<form><select name="tags" multiple><option value="a" selected>A</option><option value="b">B</option></select></form>`,
  )
  const defaults = htmlFormData.defaultFormData(form)
  assert.equal(htmlFormData.isArrayChoice(form.fields[0] as ChoiceField), true)

  const picked = formResponseData(form, defaults, [{ name: 'tags', value: ['a', 'b'] }], isArrayChoice, textValue)
  assert.deepEqual(picked, { tags: ['a', 'b'] })

  const scalar = formResponseData(form, defaults, [{ name: 'tags', value: 'a' }], isArrayChoice, textValue)
  assert.deepEqual(scalar, { tags: ['a'] })
})

/**
 * A `number` input reports a number and a cleared field is an answer, not an omission.
 *
 * Both are the engine's own rules (`textValue`, and the field-by-field path's `delete` on an empty
 * choice). Without them, a cleared prefilled field would come back as the model's recommendation,
 * and the same field would arrive as `30` on a timeout and `"30"` when edited.
 */
test('a number field reports a number and a cleared field stays cleared', () => {
  const form = parseHtmlForm(
    `<form><label>Days <input type="number" name="ttl" value="30" min="1"></label>
     <fieldset><legend>Store</legend>
       <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
       <label><input type="radio" name="store" value="redis"> Redis</label>
     </fieldset></form>`,
  )
  const defaults = htmlFormData.defaultFormData(form)
  assert.deepEqual(defaults, { ttl: 30, store: 'sqlite' })

  const edited = formResponseData(
    form,
    defaults,
    [
      { name: 'ttl', value: '7' },
      { name: 'store', value: '' },
    ],
    isArrayChoice,
    textValue,
  )
  assert.deepEqual(edited, { ttl: 7 })
})

/** An emptied group is removed rather than reported as an empty array. */
test('an emptied group is removed', () => {
  const form = parseHtmlForm(
    `<form><label><input type="checkbox" name="tags" value="a" checked> A</label>
     <label><input type="checkbox" name="tags" value="b"> B</label></form>`,
  )
  const defaults = htmlFormData.defaultFormData(form)
  const data = formResponseData(form, defaults, [{ name: 'tags', value: [] }], isArrayChoice, textValue)
  assert.deepEqual(data, {})
})

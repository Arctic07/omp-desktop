import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as htmlForm from '@oh-my-pi/pi-tui/html-form/data'
import * as htmlFormParse from '@oh-my-pi/pi-tui/html-form/parse'

import type { SessionEvents } from './events.ts'
import type { UiEngineBindings } from './ui.ts'
import { UiBridge } from './ui.ts'

/**
 * What a stop does to the dialogs the engine is waiting on.
 *
 * The engine's approval and `ask` surfaces become `extension_ui_request` frames, and a turn can be
 * aborted while one is open. The host's `cancelAll` is the one lever that closes them: it answers
 * the engine with `extension_ui_cancel` (which the desktop turns into `ui_cancelled`) and resolves
 * the waiting promise with the dialog's default, so the card goes away with the turn instead of
 * sitting there until its own timeout.
 */

function bridge() {
  const frames: Record<string, unknown>[] = []
  const timedOutCalls: string[][] = []
  const events = {
    emit: (frame: Record<string, unknown>) => {
      frames.push(frame)
    },
  } as unknown as SessionEvents
  const engine: UiEngineBindings = {
    selectOptionLabel: option => (typeof option === 'string' ? option : option.label),
    theme: {} as UiEngineBindings['theme'],
    // A spy, not a copy of the engine's rule: this file proves that the bridge *calls* the bound
    // rule on a deadline and hands its answer back, which is all it owns. The rule itself is the
    // engine's (`sdk.ts` binds `timedOutAskDialogResult`), so restating it here would be a second
    // definition that drifts.
    timedOutAsk: questions => {
      timedOutCalls.push(questions.map(question => question.id))
      return {
        kind: 'submit',
        results: questions.map(question => ({
          id: question.id,
          question: question.question,
          options: question.options.map(option => option.label),
          multi: question.multi === true,
          selectedOptions: [],
          timedOut: true,
        })),
      }
    },
    htmlForm: {
      parse: html => htmlFormParse.parseHtmlForm(html),
      defaults: form => htmlForm.defaultFormData(form),
      isArrayChoice: field => htmlForm.isArrayChoice(field),
      textValue: (field, text) => htmlForm.textValue(field, text),
    },
  }
  return { bridge: new UiBridge(events, engine, 300_000), frames, timedOutCalls }
}

test('cancelling the open dialogs answers each one and resolves it closed', async () => {
  const { bridge: ui, frames } = bridge()
  const answer = ui.context().confirm('Approve the write?', 'src/app.ts')
  assert.equal(ui.openRequests, 1)

  assert.equal(ui.cancelAll(), 1)
  assert.equal(ui.openRequests, 0)
  assert.equal(await answer, false)
  const cancels = frames.filter(frame => frame.type === 'extension_ui_cancel')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0]?.requestId, cancels[0]?.id)
})

test('a bridge with nothing open cancels nothing', () => {
  const { bridge: ui, frames } = bridge()
  assert.equal(ui.cancelAll(), 0)
  assert.equal(frames.length, 0)
})

/**
 * The engine's `secret` host hint (`ExtensionUIDialogOptions.secret`) says the answer is a
 * credential, and only the caller knows it: the desktop cannot tell a key from an objective by the
 * words in the dialog. The frame therefore carries the fact, and carries nothing at all when it was
 * not asked for — a `secret: false` on every ordinary input would be a field every reader has to
 * learn to ignore.
 */
test('a credential dialog carries the secret hint and an ordinary one does not', async () => {
  const { bridge: ui, frames } = bridge()
  const secret = ui.context().input('API key', 'sk-…', { secret: true })
  const ordinary = ui.context().input('Objective', 'what to build')
  const requests = frames.filter(frame => frame.type === 'extension_ui_request')
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.secret, true)
  assert.equal(requests[0]?.method, 'input')
  assert.equal('secret' in (requests[1] ?? {}), false)
  assert.equal(ui.cancelAll(), 2)
  assert.equal(await secret, undefined)
  assert.equal(await ordinary, undefined)
})

/**
 * A `select` whose caller names a preselection carries it, and one whose caller names none carries
 * no field at all.
 *
 * The engine's checkbox asks are re-shown once per toggle, so the caller reads back what it last
 * drew: a frame that dropped `checkedIndices` would redraw every row unchecked and the toggle would
 * never appear to take. The companions travel only beside `selectionMarker` because they describe a
 * marker, and an index outside the option list is dropped rather than sent to a window that cannot
 * point at a row there.
 */
test('a select carries the engine preselection facts and nothing the caller did not set', async () => {
  const { bridge: ui, frames } = bridge()
  const marked = ui.context().select('Which extras?', ['metrics', 'tracing', 'Done'], {
    initialIndex: 1,
    selectionMarker: 'checkbox',
    checkedIndices: [0, 7],
    markableCount: 2,
  })
  const plain = ui.context().select('Pick one', ['a', 'b'])
  const requests = frames.filter(frame => frame.type === 'extension_ui_request')
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.method, 'select')
  assert.equal(requests[0]?.initialIndex, 1)
  assert.equal(requests[0]?.selectionMarker, 'checkbox')
  // Index 7 is past the three options, so only the row that exists travels.
  assert.deepEqual(requests[0]?.checkedIndices, [0])
  assert.equal(requests[0]?.markableCount, 2)
  // A select with no preselection says nothing: an absent field is "the caller named none".
  for (const field of ['initialIndex', 'selectionMarker', 'checkedIndices', 'markableCount']) {
    assert.equal(field in (requests[1] ?? {}), false, field)
  }
  assert.equal(ui.cancelAll(), 2)
  assert.equal(await marked, undefined)
  assert.equal(await plain, undefined)
})

/**
 * A deadline that the desktop reports as expired answers through the engine's bound rule.
 *
 * Two owners can reach the deadline - this host's own timer and the desktop's expiry of the same
 * request - and both must hand back the engine's answer rather than cancelling the turn. The bridge
 * owns the call, not the rule, so the assertion is that the bound function ran with these questions
 * and that its answer is what resolved the dialog.
 */
test('an expired ask dialog answers through the engine rule and not by cancelling', async () => {
  const { bridge: ui, frames, timedOutCalls } = bridge()
  const answer = ui.context().askDialog!([
    { id: 'q1', question: 'Which store?', options: [{ label: 'sqlite' }, { label: 'redis' }], recommended: 1 },
  ])
  const request = frames.find(frame => frame.type === 'extension_ui_request')
  assert.equal(request?.method, 'ask')

  ui.respond(String(request?.id), { cancelled: true, timedOut: true })

  const result = await answer
  assert.equal(timedOutCalls.length, 1)
  assert.deepEqual(timedOutCalls[0], ['q1'])
  assert.equal(result?.kind, 'submit')
  assert.equal(result?.kind === 'submit' ? result.results[0]?.timedOut : undefined, true)
})

/**
 * A markable count may cover the whole list, while an index may not point past it.
 *
 * The engine sends `markableCount === options.length` whenever its "Done" row is absent, so the
 * count is bounded by `<=` and the index by `<`; using one predicate for both would drop a fact the
 * engine did state. Repeated indices are one row each - an extension can call `ui.select` directly,
 * and one entry per repetition is a frame this process should not relay.
 */
test('a markable count may equal the list length and repeated indices collapse', async () => {
  const { bridge: ui, frames } = bridge()
  const answer = ui.context().select('Which?', ['a', 'b'], {
    selectionMarker: 'checkbox',
    checkedIndices: [1, 1, 0, 1],
    markableCount: 2,
  })
  const request = frames.find(frame => frame.type === 'extension_ui_request')
  assert.equal(request?.markableCount, 2)
  assert.deepEqual(request?.checkedIndices, [1, 0])
  // An index equal to the length is past the end and travels nowhere.
  const past = ui.context().select('Which?', ['a', 'b'], { initialIndex: 2 })
  const pastRequest = frames.filter(frame => frame.type === 'extension_ui_request')[1]
  assert.equal('initialIndex' in (pastRequest ?? {}), false)
  assert.equal(ui.cancelAll(), 2)
  assert.equal(await answer, undefined)
  assert.equal(await past, undefined)
})

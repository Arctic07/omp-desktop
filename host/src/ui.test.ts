import assert from 'node:assert/strict'
import { test } from 'node:test'

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
  const events = {
    emit: (frame: Record<string, unknown>) => {
      frames.push(frame)
    },
  } as unknown as SessionEvents
  const engine: UiEngineBindings = {
    selectOptionLabel: option => (typeof option === 'string' ? option : option.label),
    theme: {} as UiEngineBindings['theme'],
  }
  return { bridge: new UiBridge(events, engine, 300_000), frames }
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

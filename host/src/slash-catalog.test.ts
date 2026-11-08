import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SERVED, UI_SURFACE, servedCommandEntries, terminalOnlyCommands } from './slash-catalog.ts'

/**
 * The maintenance contract for "every CLI command is in the desktop palette".
 *
 * The engine ships some builtins only for its terminal (`handleTui` with no `handle`), and those are
 * invisible to the advertisement the host receives. This test walks the engine's own registry and
 * requires every such command to be either served here (with a dispatcher) or recorded as a UI
 * surface. A new engine command, or one that gains/loses a text handler, therefore fails this test
 * instead of disappearing from the palette unnoticed.
 */

test('every terminal-only engine command is served or recorded as a UI surface', () => {
  const unaccounted = terminalOnlyCommands()
    .map((command) => command.name)
    .filter((name) => SERVED[name] !== true && UI_SURFACE[name] === undefined)
  assert.deepEqual(unaccounted, [])
})

test('nothing is claimed that the engine does not ship as terminal-only', () => {
  const terminalOnly = new Set(terminalOnlyCommands().map((command) => command.name))
  const claimed = [...Object.keys(SERVED), ...Object.keys(UI_SURFACE)]
  assert.deepEqual(
    claimed.filter((name) => !terminalOnly.has(name)),
    [],
  )
})

test('a served command is advertised with the engine’s own metadata', () => {
  const entries = servedCommandEntries()
  assert.deepEqual(
    entries.map((entry) => entry.name),
    terminalOnlyCommands()
      .map((command) => command.name)
      .filter((name) => SERVED[name] === true),
  )
  const goal = entries.find((entry) => entry.name === 'goal')
  assert.ok(goal !== undefined)
  // The words are the engine's registry entry, not a copy: a hint or a subcommand the engine
  // changes reaches the palette with the engine's next release.
  assert.deepEqual(goal.input, { hint: '[objective]' })
  assert.ok((goal.subcommands ?? []).some((sub) => sub.name === 'budget'))
  for (const entry of entries) assert.equal(entry.source, 'builtin')
})

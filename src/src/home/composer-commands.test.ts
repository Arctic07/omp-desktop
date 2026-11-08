import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  commandDraft,
  commandQuery,
  matchCommands,
  withDesktopUiCommands,
} from './composer-commands.ts'
import type { EngineCommand } from '../api/session-types.ts'

/**
 * What the composer's command list reads: which drafts ask for a command, which command a query
 * finds first, and what a chosen one leaves in the field. The list itself belongs to the engine, so
 * these are the readings this side is allowed to have opinions about.
 */

function command(
  name: string,
  options: { description?: string; aliases?: string[]; source?: string } = {},
): EngineCommand {
  return {
    name,
    description: options.description ?? `${name} does something`,
    aliases: options.aliases ?? [],
    inputHint: '',
    subcommands: [],
    source: options.source ?? 'builtin',
  }
}

const COMMANDS = [
  command('model', { description: 'Choose the model', aliases: ['m'] }),
  command('skill:deploy', { description: 'Ship the current build', source: 'skill' }),
  command('skill:review', { description: 'Review the diff', source: 'skill' }),
  command('compact', { description: 'Compact the conversation' }),
  command('mcp', { description: 'Manage MCP servers' }),
]

test('only a draft that begins with one command word opens the list', () => {
  assert.equal(commandQuery('/'), '')
  assert.equal(commandQuery('/sk'), 'sk')
  assert.equal(commandQuery('/SK'), 'sk')
  assert.equal(commandQuery('/skill:deploy'), 'skill:deploy')
  assert.equal(commandQuery('/model '), null)
  assert.equal(commandQuery('/model gpt'), null)
  assert.equal(commandQuery('run /model'), null)
  assert.equal(commandQuery(' /model'), null)
  assert.equal(commandQuery(''), null)
})

test('an empty query is the engine list, in the engine order', () => {
  assert.deepEqual(
    matchCommands(COMMANDS, '').map((item) => item.name),
    ['model', 'skill:deploy', 'skill:review', 'compact', 'mcp'],
  )
})

test('a name that begins with the query outranks a description that mentions it', () => {
  assert.deepEqual(
    matchCommands(COMMANDS, 'model').map((item) => item.name),
    ['model'],
  )
  assert.deepEqual(
    matchCommands(COMMANDS, 'comp').map((item) => item.name),
    ['compact'],
  )
})

test('skills are found by their command name, not only by their skill name', () => {
  assert.deepEqual(
    matchCommands(COMMANDS, 'skill:').map((item) => item.name),
    ['skill:deploy', 'skill:review'],
  )
  assert.deepEqual(
    matchCommands(COMMANDS, 'ship').map((item) => item.name),
    ['skill:deploy'],
  )
})

test('an alias finds its command, but a name that begins with the query still wins', () => {
  assert.deepEqual(
    matchCommands([command('config', { aliases: ['cfg'] }), command('cfgfile')], 'cfg').map(
      (item) => item.name,
    ),
    ['cfgfile', 'config'],
  )
  // Both names begin with the query, so this is a tie rather than a ranking question: the engine's
  // order decides, not the sort's.
  assert.deepEqual(
    matchCommands([command('status'), command('stats')], 'st').map((item) => item.name),
    ['status', 'stats'],
  )
})

test('a query that matches nothing lists nothing', () => {
  assert.deepEqual(matchCommands(COMMANDS, 'zzz'), [])
})

test('the desktop navigation command sits after the engine builtins and replaces a shadowing entry', () => {
  const merged = withDesktopUiCommands([
    command('model'),
    command('new', { source: 'file' }),
    command('skill:deploy', { source: 'skill' }),
  ])
  assert.deepEqual(
    merged.map((item) => `${item.source}:${item.name}`),
    ['builtin:model', 'desktop:new', 'skill:skill:deploy'],
  )
})

test('/new is findable by the palette like any other command', () => {
  const merged = withDesktopUiCommands(COMMANDS)
  assert.deepEqual(matchCommands(merged, 'new').map((item) => item.name), ['new'])
})

test('a chosen command replaces the question with the command and a space', () => {
  assert.equal(commandDraft('skill:deploy'), '/skill:deploy ')
})

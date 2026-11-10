import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commandReportCode, runSlashCommand } from './slash.ts'
import type { SlashCommandOptions } from './slash.ts'

/**
 * The command path's own side effects.
 *
 * A command the engine dispatches in the background (`/compact`, `/handoff`, a no-argument
 * `/rename`) reports after the prompt's acknowledgement has already gone out. The state snapshot
 * published with that acknowledgement is therefore the pre-command one, and nothing else would
 * ever publish the occupancy the command changed - which is why a `/compact` used to finish with
 * its line on screen and the context gauge still showing the tokens it had just dropped.
 */

test('a background command republishes the session state when its work finishes', async () => {
  let published = 0
  let finish!: () => void
  const work = new Promise<void>((resolve) => {
    finish = resolve
  })
  const options = {
    sdk: {
      parseSkillInvocation: () => undefined,
      parseSlashCommand: () => null,
      executeBuiltinCommand: async (_text: string, runtime: { runCommandInBackground?: (task: () => Promise<void>) => void }) => {
        runtime.runCommandInBackground?.(() => work)
        return { consumed: true }
      },
    },
    session: {
      skillsSettings: undefined,
      skills: [],
      isStreaming: false,
      settings: {},
      sessionManager: { getCwd: () => process.cwd() },
    },
    output: () => {},
    refreshCommands: async () => {},
    publishState: () => {
      published += 1
    },
    publishTitle: () => {},
    behavior: undefined,
    goal: {},
    ui: {},
  } as unknown as SlashCommandOptions

  assert.deepEqual(await runSlashCommand(options, '/compact'), {
    kind: 'handled',
    agentInvoked: false,
  })
  assert.equal(published, 0)
  finish()
  await work
  await Promise.resolve()
  assert.equal(published, 1)
})

test('only the compaction command reports into the transcript', () => {
  // The code is what routes a `/compact` report to the conversation instead of the notice strip
  // (`src/src/state/transcript.ts`); every other command keeps the strip.
  assert.equal(commandReportCode('/compact'), 'engine_compaction_report')
  assert.equal(commandReportCode('/compact keep the plan so far'), 'engine_compaction_report')
  assert.equal(commandReportCode('  /compact  '), 'engine_compaction_report')
  // A command whose address merely starts the same way is not the compaction.
  assert.equal(commandReportCode('/compactfoo'), undefined)
  assert.equal(commandReportCode('/rename New name'), undefined)
  assert.equal(commandReportCode('compact now'), undefined)
})

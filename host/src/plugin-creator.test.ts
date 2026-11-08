import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PLUGIN_CREATOR_DESCRIPTION, PLUGIN_CREATOR_NAME, seedPluginCreator } from './plugin-creator.ts'
import { seedSkillCreator } from './skill-creator.ts'

/**
 * The two authoring recipes the app's own surfaces invoke.
 *
 * What matters is not the wording but the three properties the seeding contract states: the file is
 * written on a fresh data root, a restart does not overwrite a reader's edit, and the frontmatter
 * `name` is the directory name - which is what makes `/skill:<name>` resolve and what the engine's
 * discovery keys on.
 */

test('the plugin recipe lands under skills/plugin-creator with its own frontmatter', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-native-skill-'))
  seedPluginCreator(agentDir)
  const body = fs.readFileSync(path.join(agentDir, 'skills', PLUGIN_CREATOR_NAME, 'SKILL.md'), 'utf8')
  assert.match(body, new RegExp(`^---\\nname: ${PLUGIN_CREATOR_NAME}\\ndescription: `))
  assert.ok(body.includes(PLUGIN_CREATOR_DESCRIPTION))
  // The marker is what lets a later build tell an untouched copy from one the reader edited.
  assert.match(body, /\n<!-- omp-desktop-seed:[0-9a-f]{64} -->\n$/)
  // The manifest facts a plugin author needs are in the body, not only in the app's source.
  for (const token of ['omp.desktop.sidebarTabs', 'ui.tab', 'ui.theme', 'agent.extension']) {
    assert.ok(body.includes(token), `the recipe names ${token}`)
  }
})

test('a second start leaves an edited recipe alone', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-native-skill-'))
  seedPluginCreator(agentDir)
  const file = path.join(agentDir, 'skills', PLUGIN_CREATOR_NAME, 'SKILL.md')
  // What the reader's edit is: the seeded text changed, and the marker it came with stays. A file
  // with no marker at all is a different case - an older build's copy, or a recipe written under this
  // name - and `native-skill.test.ts` states what happens to that one.
  const seeded = fs.readFileSync(file, 'utf8')
  const edited = seeded.replace('# 插件创建器', '# 我的插件创建器')
  assert.notEqual(edited, seeded, 'the edit changed a byte, so the check below is not vacuous')
  fs.writeFileSync(file, edited, 'utf8')
  seedPluginCreator(agentDir)
  assert.equal(fs.readFileSync(file, 'utf8'), edited)
})

test('the two recipes do not write over each other', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-native-skill-'))
  seedSkillCreator(agentDir)
  seedPluginCreator(agentDir)
  const skills = path.join(agentDir, 'skills')
  const skillCreator = fs.readFileSync(path.join(skills, 'skill-creator', 'SKILL.md'), 'utf8')
  const pluginCreator = fs.readFileSync(path.join(skills, PLUGIN_CREATOR_NAME, 'SKILL.md'), 'utf8')
  assert.match(skillCreator, /^---\nname: skill-creator\n/)
  assert.match(pluginCreator, new RegExp(`^---\\nname: ${PLUGIN_CREATOR_NAME}\\n`))
  // Each recipe names the other, so "make me a skill" selects one of them rather than both.
  assert.ok(skillCreator.includes(PLUGIN_CREATOR_NAME), 'skill-creator names plugin-creator')
  assert.ok(pluginCreator.includes('skill-creator'), 'plugin-creator names skill-creator')
})

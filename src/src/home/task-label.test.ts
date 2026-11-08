import assert from 'node:assert/strict'
import { test } from 'node:test'

import { taskLabel } from './task-roster.ts'

/**
 * What a child's row prints as its name.
 *
 * A child labelled by the engine has a one-sentence name; a child that has none yet falls back to
 * its assignment, which is written as a document (`# Target …`, `**前端**`, `` `path` ``). The row
 * states its first line — the report was that a whole prompt, markup and all, was printed in it.
 */

test('a heading and its section word are not part of the name', () => {
  assert.equal(
    taskLabel('# Target 勘察本仓库的**前端**: `D:/project/omp-desktop/src` 的结构'),
    '勘察本仓库的前端: D:/project/omp-desktop/src 的结构',
  )
})

test('the first line is the name, and an empty line before it is skipped', () => {
  assert.equal(taskLabel('\n\n# Change\n只看 diff。'), '只看 diff。')
  assert.equal(taskLabel('分别查看前后端现状\n\n更多说明'), '分别查看前后端现状')
})

test('a plain label is left alone, and a missing book is no name at all', () => {
  assert.equal(taskLabel('修复登录跳转'), '修复登录跳转')
  assert.equal(taskLabel(null), '')
  assert.equal(taskLabel('   \n\t '), '')
})

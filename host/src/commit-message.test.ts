import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { BootServices } from './boot.ts'
import { draftCommitMessage } from './commit-message.ts'
import { COMMIT_DRAFT_BUDGET_ENV } from './constants.ts'
import type { SdkBundle } from './sdk.ts'

/**
 * The commit draft's budget: what this process answers when the engine's pipeline outlives it, and
 * when it does not.
 *
 * The pipeline itself is the engine's, so what is pinned here is the contract this file owns - a
 * draft answers inside its own budget instead of being dropped by the desktop as a late frame, an
 * expiry is not mistaken for an engine refusal (which would start the fallback generator over again
 * with nothing left to spend), and an engine failure still reaches the fallback.
 */

/** A bundle whose engine surface is only what a draft reaches. */
function fakeSdk(overrides: Partial<Record<keyof SdkBundle, unknown>>): SdkBundle {
  return {
    resolvePrimaryModel: async () => ({
      model: { provider: 'anthropic', id: 'claude', name: 'Claude' },
      thinkingLevel: 'medium',
    }),
    formatConventionalCommit: () => 'feat(host): answer the draft',
    ...overrides,
  } as unknown as SdkBundle
}

function fakeServices(cwd: string): BootServices {
  return { settings: {}, registry: { getAvailable: () => [] }, cwd } as unknown as BootServices
}

/** Runs one draft with a shortened budget, and leaves the environment as it was. */
async function withBudget<T>(budgetMs: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env[COMMIT_DRAFT_BUDGET_ENV]
  process.env[COMMIT_DRAFT_BUDGET_ENV] = String(budgetMs)
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[COMMIT_DRAFT_BUDGET_ENV]
    else process.env[COMMIT_DRAFT_BUDGET_ENV] = previous
  }
}

test('a pipeline that outlives the budget is answered by the budget, not by the desktop', async () => {
  let fallbackCalls = 0
  const sdk = fakeSdk({
    generateGitCommit: () => new Promise(() => undefined),
    generateCommitMessage: async () => {
      fallbackCalls += 1
      return 'feat: from the fallback'
    },
  })
  const startedAt = Date.now()
  const error = await withBudget(1_000, async () =>
    draftCommitMessage(sdk, fakeServices(process.cwd()), { cwd: process.cwd() }).then(
      () => assert.fail('the draft answered although its pipeline never did'),
      (raised: unknown) => raised,
    ),
  )
  const elapsedMs = Date.now() - startedAt
  assert.match(String(error), /Drafting the commit message stopped after 1 s/)
  assert.ok(elapsedMs >= 1_000 && elapsedMs < 5_000, `answered after ${String(elapsedMs)} ms`)
  // An expiry is this process's own deadline: running the fallback would start the same work again
  // with nothing left of it, and the answer the reader gets would be another timeout.
  assert.equal(fallbackCalls, 0)
})

test('a pipeline that answers is passed through unchanged', async () => {
  const sdk = fakeSdk({
    generateGitCommit: async () => ({ commit: {}, stagedAll: true }),
    generateCommitMessage: async () => 'feat: from the fallback',
  })
  const draft = await withBudget(5_000, async () =>
    draftCommitMessage(sdk, fakeServices(process.cwd()), { cwd: process.cwd() }),
  )
  assert.deepEqual(draft, { message: 'feat(host): answer the draft', stagedAll: true })
})

test('an engine failure still reaches the fallback generator', async () => {
  let fallbackCalls = 0
  const sdk = fakeSdk({
    generateGitCommit: async () => {
      throw new Error('401 Invalid API key')
    },
    generateCommitMessage: async () => {
      fallbackCalls += 1
      return 'feat: from the fallback'
    },
  })
  // A directory that is not a repository has no staged diff, so the fallback answers null after
  // reading one - which is how this case proves the fallback was entered, not that it was skipped.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-draft-'))
  try {
    const error = await withBudget(5_000, async () =>
      draftCommitMessage(sdk, fakeServices(empty), { cwd: empty }).then(
        () => assert.fail('an empty index is not a draft'),
        (raised: unknown) => raised,
      ),
    )
    assert.match(String(error), /401 Invalid API key/)
    assert.match(String(error), /both failed/)
    assert.equal(fallbackCalls, 0)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

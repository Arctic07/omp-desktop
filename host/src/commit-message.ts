/**
 * One commit message, drafted from the staged tree.
 *
 * The engine owns the draft: `generateGitCommit` reads `git diff --cached` in the repository, runs
 * the whole conventional-commit pipeline on the model it is handed, and `formatConventionalCommit`
 * renders the answer. The host only carries the request and the answer across; nothing here
 * composes a prompt when the primary path works.
 *
 * **The fallback exists because the pipeline builds its own credential store.** `generateGitCommit`
 * calls the engine's `discoverAuthStorage`, which opens the engine's on-disk credential store; the
 * key this desktop holds lives in the OS keyring and is installed as a runtime override on the
 * *host's* `AuthStorage` (`auth-keys.ts`), so the fresh store can resolve a stale stored key and
 * answer `401 Invalid API key` while every chat turn on the same provider works (2026-10-20, user
 * report). When the pipeline fails and there is a staged diff, the engine's own lighter generator
 * runs instead: `generateCommitMessage` reads credentials through the shared registry, where that
 * override lives, and walks its candidate models until one answers. Both paths are the engine's;
 * no prompt is written here.
 *
 * `stageIfEmpty: false` is deliberate. The engine's own `omp commit` stages the whole tree when the
 * index is empty, because there it is about to commit; this command only drafts a message, and the
 * desktop's review panel decides what gets staged. An empty index is then the engine's own
 * "No staged changes to analyze", which the panel reports to the reader.
 *
 * **The draft answers inside {@link COMMIT_DRAFT_BUDGET_MS}.** Both paths are model calls the engine
 * retries on its own terms - three attempts of a 120 s ceiling each, per operation - so a stalled
 * provider can outlast any budget the desktop sets for the frame. The desktop used to learn that the
 * hard way: its 120 s call budget expired, the pending request was dropped, and the answer arrived
 * as `a response frame did not match any pending request id` (2026-10-29). The budget here is
 * therefore the *inner* one: it stops the pipeline through the abort signal, races the fallback that
 * cannot take one, and answers with its own message before the desktop's outer timeout can fire.
 */

import type { BootServices } from './boot.ts'
import { COMMIT_DRAFT_BUDGET_ENV, COMMIT_DRAFT_BUDGET_MS } from './constants.ts'
import { logLine } from './log.ts'
import { text } from './protocol/fields.ts'
import type { SdkBundle } from './sdk.ts'

/** What one draft answers with: the message, and whether the engine had to stage anything. */
export interface CommitMessageDraft {
  readonly message: string
  readonly stagedAll: boolean
}

/**
 * How much of the staged diff the fallback reads.
 *
 * The generator truncates to 4000 characters of its own, so this only has to be comfortably above
 * that: enough for its noise filter to drop a lockfile and still see the code, small enough that a
 * repository with a giant generated diff cannot make this process hold it all.
 */
const STAGED_DIFF_MAX_BYTES = 128 * 1024

/**
 * The draft budget in force, which the smoke shortens through {@link COMMIT_DRAFT_BUDGET_ENV} so a
 * stalled provider's deadline can be observed in seconds instead of minutes. A value that is not a
 * positive number leaves the shipped budget alone.
 */
function configuredCommitDraftBudgetMs(): number {
  const raw = process.env[COMMIT_DRAFT_BUDGET_ENV]
  if (raw === undefined || raw === '') return COMMIT_DRAFT_BUDGET_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : COMMIT_DRAFT_BUDGET_MS
}

export async function draftCommitMessage(
  sdk: SdkBundle,
  services: BootServices,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = text(request.cwd, 'cwd', true) as string
  const startedAt = performance.now()
  const budgetMs = configuredCommitDraftBudgetMs()
  // One controller for both halves of the budget: `abort` is what stops the engine's pipeline, and
  // the same moment rejects the race below for the fallback generator, which takes no signal.
  // `AbortSignal.timeout` would be shorter to write but does not settle on its own in this runtime:
  // with nothing else on the event loop the draft hung past its deadline.
  const controller = new AbortController()
  const { promise: expired, reject: rejectExpired } = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    controller.abort()
    rejectExpired(new Error(`Drafting the commit message stopped after ${Math.round(budgetMs / 1000)} s: the model did not answer in time.`))
  }, budgetMs)
  try {
    const draft = await Promise.race([draftOnce(sdk, services, cwd, controller.signal), expired])
    logLine(
      `commit message drafted by the engine's ${draft.source} in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`,
    )
    return { message: draft.message, stagedAll: draft.stagedAll } satisfies CommitMessageDraft
  } catch (error) {
    logLine(`commit message draft gave up after ${((performance.now() - startedAt) / 1000).toFixed(1)} s: ${describe(error)}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** One draft, and which of the engine's two paths answered it. */
interface Draft {
  readonly message: string
  readonly stagedAll: boolean
  readonly source: 'commit pipeline' | 'fallback generator'
}

/**
 * The draft itself: the pipeline, then - when that failed for a reason other than this process's
 * own deadline - the engine's lighter generator over the same staged diff.
 *
 * The deadline is handed to the pipeline, which passes it into its inference calls, so an expired
 * budget stops the model calls rather than waiting them out. The fallback takes no signal, which is
 * why {@link expired} races it: a fallback that starts near the end of the budget is answered for
 * by the race, and the abandoned call settles into nothing.
 */
async function draftOnce(
  sdk: SdkBundle,
  services: BootServices,
  cwd: string,
  deadline: AbortSignal,
): Promise<Draft> {
  try {
    const model = await commitModelSelector(sdk, services)
    const result = await sdk.generateGitCommit({
      cwd,
      stageIfEmpty: false,
      modelOverride: model,
      signal: deadline,
    })
    const draft: Draft = {
      message: sdk.formatConventionalCommit(result.commit),
      stagedAll: result.stagedAll,
      source: 'commit pipeline',
    }
    return draft
  } catch (error) {
    // Our own deadline is not the engine refusing: the fallback would start the same work again
    // with what little is left, so the deadline is the answer instead.
    if (deadline.aborted) throw error
    const fallback = await fallbackCommitMessage(sdk, services, cwd)
    if (fallback !== null) {
      logLine(`commit message drafted by the engine's fallback generator: ${describe(error)}`)
      return { message: fallback, stagedAll: false, source: 'fallback generator' }
    }
    throw new Error(
      `${describe(error)} - the commit pipeline and its fallback generator both failed; check the provider key for the model settings use.`,
    )
  }
}

/**
 * The second draft: the engine's one-shot generator over the same staged diff.
 *
 * Only the diff is read here. An empty index answers `null` rather than a message, which is how the
 * pipeline's own "No staged changes to analyze" stays the error the reader sees: there is nothing
 * to draft from, and inventing a sentence for it would be a message about nothing.
 */
async function fallbackCommitMessage(
  sdk: SdkBundle,
  services: BootServices,
  cwd: string,
): Promise<string | null> {
  const diff = await stagedDiff(cwd).catch(() => '')
  if (!diff.trim()) return null
  try {
    const message = await sdk.generateCommitMessage(diff, services.registry, services.settings)
    const trimmed = message?.trim() ?? ''
    return trimmed === '' ? null : trimmed
  } catch (error) {
    logLine(`the fallback commit generator failed: ${describe(error)}`)
    return null
  }
}

/** The staged diff, capped, read without loading a whole repository into memory. */
async function stagedDiff(cwd: string): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', 'diff', '--cached', '--no-color', '--no-ext-diff', '--unified=3'],
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const reader = child.stdout.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (bytes < STAGED_DIFF_MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
    }
  } finally {
    // The cap may have stopped the read early; git then has nobody to write the rest to.
    child.kill()
    await reader.cancel().catch(() => undefined)
  }
  await child.exited.catch(() => undefined)
  const buffer = new Uint8Array(Math.min(bytes, STAGED_DIFF_MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= buffer.length) break
    const slice = chunk.subarray(0, buffer.length - offset)
    buffer.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder().decode(buffer)
}

/** What a failure said, without its stack: this text reaches the reader. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The model the draft runs on, named the way the engine's own role chain resolves it.
 *
 * `generateGitCommit` resolves its `smol` role through the engine's built-in priority list when no
 * model is passed, and that list reaches models this machine is not allowed to call (a free tier
 * that answers 403 outside its region) - the draft then dies with the provider's refusal instead of
 * a message. Passing the resolved primary keeps every inference role on the model the settings
 * already chose, which is what the engine's own agentic commit does. The thinking level travels
 * with the selector because the pipeline turns it into the request's reasoning effort.
 */
async function commitModelSelector(sdk: SdkBundle, services: BootServices): Promise<string> {
  const primary = await sdk.resolvePrimaryModel(undefined, services.settings, services.registry)
  const selector = `${primary.model.provider}/${primary.model.id}`
  return primary.thinkingLevel === undefined ? selector : `${selector}:${primary.thinkingLevel}`
}

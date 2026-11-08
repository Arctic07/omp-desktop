/**
 * When a session still counts as working, what a stop has to end, and the release a screen's
 * hand-back waits for.
 *
 * Those three are one fact read from three sides, which is why they are one module and not three:
 * "still working" is answered from the engine's own bookkeeping (the running turn, background work
 * that can still wake the session) plus the children this host can still cancel (`isWorking`), the
 * stop is the command that acts on exactly that answer (`stopSession`), and the deferred release is
 * the gate that may not run until the answer is no (`releaseWhenDone`). A gate that read the turn
 * bit alone would call a detached `task` batch idle - and then dispose the session under work the
 * user asked for - which is the failure all three exist to prevent.
 *
 * Split out of the registry because none of them touches the registry's own state: each acts on one
 * record, and the only two things they need from the map that owns it are the identity check and
 * the removal (`SessionStopPort`). What they do read - the session's engine object, its child
 * watch, its event pipe, its release flags - is the record itself.
 */

import {
  STOP_ABORT_GRACE_MS,
  STOP_CHILD_CANCEL_GRACE_MS,
  USER_INTERRUPT_LABEL,
} from './constants.ts'
import { logError, logLine } from './log.ts'
import { cancelBtw } from './btw.ts'
import { abortCleanse } from './cleanse.ts'
import { pauseLoop } from './loop-mode.ts'
import { text } from './protocol/fields.ts'
import { disposeSession, releaseWorkspaceLsp } from './session-lifecycle.ts'
import { emitSessionState } from './session-view.ts'
import type { AgentSession, SdkBundle } from './sdk.ts'
import type { LiveSession } from './sessions.ts'
import { silenceStoppedResults } from './stop-results.ts'

/** What the stop and the release gate need from the registry that owns the records. */
export interface SessionStopPort {
  /** Engine services: the stop silences the wakes its own kills produce through the engine's message type. */
  readonly sdk: SdkBundle
  /**
   * Whether the registry still holds this exact record under its id.
   *
   * The identity matters and not the id alone: a record released and opened again is a different
   * object under the same id, and a release scheduled for the one that went away must not take the
   * one that came back down with it.
   */
  held: (live: LiveSession) => boolean
  /** Takes a record out of the registry; the caller disposes what this removes. */
  drop: (sessionId: string) => void
  /**
   * Whether any session the registry still holds was opened in this workspace.
   *
   * Asked after the record is dropped, so it answers about the sessions this release left behind
   * rather than about the one going away.
   */
  usesWorkspace: (cwd: string) => boolean
}

/**
 * Whether a session still has work that is not over: the turn the engine is running, a submission
 * it has taken but not started yet, a compaction it is running, background work that can still wake
 * it, or a child this host still tracks as live.
 *
 * The parts come apart in exactly the cases that matter. A detached `task` batch keeps running
 * while the turn is idle and nothing is streaming, so a gate reading `isStreaming` alone would call
 * such a session quiet - and then evict it, or dispose it, under the work it is still holding. And
 * `prompt()` answers `{accepted:true}` the moment the engine takes a submission, while the turn it
 * will start is still being prepared (image normalization and the like): in that window
 * `isStreaming` is still false, and everything below that reads this gate - the eviction candidate,
 * the deferred release, a screen letting go, the close refusal - would be free to end a session the
 * desktop has already reported as answering. The engine keeps that window in its own bookkeeping
 * (`hasAdmittedSubmission`), so this reads it here instead of inferring it from the turn bit.
 *
 * The first four parts are the engine's own bookkeeping (`isStreaming`, `hasAdmittedSubmission`,
 * `isCompacting`, `hasPendingAsyncWork()`), the fifth is the child set `SubagentWatch.liveIds`
 * answers with, which
 * reads the engine's registry beside the frames (see `subagents.ts` for why the frames cannot be
 * the only source: they only hold what arrived while the record was watching, and a background
 * batch outlives a release, so a session opened again holds children no frame of which it saw
 * start). Every gate that may not cut work short reads this and not the turn bit: the answer to
 * `session_abort`, the eviction candidate, the deferred release, and a screen letting go (`close`).
 */
export function isWorking(live: Pick<LiveSession, 'agent' | 'subagents' | 'goal'>): boolean {
  return (
    live.agent.isStreaming ||
    live.agent.hasAdmittedSubmission ||
    // A compaction (or a handoff, which the same flag covers) is the engine spending a model call
    // to rewrite the context. It runs with no turn in flight, so every gate that reads only the turn
    // bit answers "nothing is happening": a stop would say there was nothing to stop while the
    // engine kept paying for it, and a close or an eviction would dispose the session mid-pass.
    live.agent.isCompacting ||
    live.agent.hasPendingAsyncWork() ||
    // A goal continuation is decided at a yield and admitted on the next tick: between the two the
    // engine itself is idle, yet this session has work it is about to do (the engine's RPC host
    // reports the same window as unsettled). Without it a stop or a close here would say "nothing
    // to stop" and then let the goal turn start anyway.
    live.goal.continuationPending ||
    live.subagents.liveIds(live.agent.getAgentId()).length > 0 ||
    // The jobs this stop can actually cancel, read the same way `cancelBackgroundJobs` reads them.
    // `hasPendingAsyncWork()` is not that set: it asks whether a running job's result can still wake
    // this session, and a delivery that is acknowledged or watched is suppressed while its job runs
    // on. That gap was a lock-up (2026-10-27, user report): the state frame publishes every running
    // job as `backgroundJobs` - the screen draws a stop for it - while this answer said "nothing to
    // stop", and because the early return happens before the kills, nothing ever cancelled it. Each
    // press answered the same thing and left the control standing.
    runningJobs(live.agent).length > 0
  )
}

/**
 * A background job this session is still running, as far as the stop needs it.
 *
 * Structural on purpose: the only identity a stop uses is the id (the kill is scoped by owner, and
 * the id is what its result is silenced by), so the module names that part instead of the engine's
 * whole job row.
 */
export interface RunningJob {
  readonly id: string
}

/**
 * The background jobs this session is still running, scoped to its own agent id.
 *
 * One read for every surface that asks about them: the stop's own kills, the counts a forced
 * teardown reports, and the busy fact above (`session-view.ts` publishes the same set as the state
 * frame's `backgroundJobs`). The manager is process-wide, so the owner scope is the boundary that
 * keeps one conversation from counting - or killing - another's work.
 */
function runningJobs(agent: AgentSession): readonly RunningJob[] {
  const manager = agent.asyncJobManager
  const ownerId = agent.getAgentId()
  if (manager === undefined || ownerId === undefined) return []
  return manager.getRunningJobs({ ownerId })
}

/**
 * One stop's answer: what it ended, and what still reads busy afterwards.
 *
 * `remaining` is the same busy facts {@link isWorking} reads, named one by one and read *after*
 * the kills, because a stop that landed can still leave work behind (a queued message behind an
 * aborted turn, background work whose result the engine still owes). The caller draws "it is
 * still running" from this rather than guessing from its own copy of the session.
 *
 * A type alias rather than an interface on purpose: the dispatcher answers with
 * `Record<string, unknown>`, and only an object *type* carries the implicit index signature that
 * makes this assignable to it.
 */
export type StopOutcome = {
  aborted: boolean
  cancelledSubagents: number
  cancelledJobs: number
  remaining: string[]
  /**
   * The reader's own queued input this stop withdrew, oldest first, as the text they wrote.
   *
   * A steer or follow-up waiting behind the turn is a message the engine would run the moment the
   * abort settles (`session/agent-session.ts::#scheduleQueuedMessageDrain` resumes a steering queue
   * from any tail), so a stop that left it in place was followed by a fresh turn within
   * milliseconds - the report this field answers. A stop therefore withdraws the queue first, the
   * way the engine's own terminal does on Esc (`input-controller.ts`'s `clearQueue({ forInterrupt:
   * true })`), and answers with what it took so the screen can hand the words back to the reader.
   * Dropping them silently would lose input nobody sent.
   */
  restored: string[]
}

/**
 * The busy facts of one session, as the words the stop reports them in.
 *
 * The same reads `isWorking` folds into one boolean, kept apart here because a caller needs to say
 * *what* is left - "the turn did not stop" and "a background job is still running" are different
 * answers to the user who just pressed stop.
 */
function busyFacets(live: Pick<LiveSession, 'agent' | 'subagents'>): string[] {
  const facets: string[] = []
  if (live.agent.isStreaming || live.agent.hasAdmittedSubmission) facets.push('turn')
  // A compaction spends a model call with the turn bit idle, so `turn` alone would call the stop
  // finished while the engine was still paying for it.
  if (live.agent.isCompacting) facets.push('compaction')
  if (live.agent.hasPendingAsyncWork()) facets.push('background')
  // The jobs a press could not end, named apart from the engine's wider "still owes a result":
  // `backgroundJobs` in the state frame is this same set, so a screen that drew a stop for one is
  // told here that it is still there (see `isWorking`'s note on the suppression gap).
  if (runningJobs(live.agent).length > 0) facets.push('jobs')
  if (live.subagents.liveIds(live.agent.getAgentId()).length > 0) facets.push('children')
  if (live.agent.queuedMessageCount > 0) facets.push('queued')
  return facets
}

/**
 * Ends the background jobs this session owns, through the engine's own job manager.
 *
 * The engine's `abort()` does not reach them. A bash or eval call that outlived its foreground
 * wait is handed to the async job manager (`async/auto-background.ts`), and aborting the turn only
 * stops the turn: the job keeps running, keeps `hasPendingAsyncWork()` true - so the session keeps
 * reading busy on every surface that reads that fact - and eventually delivers its result back into
 * the session as a fresh wake. That is the state a user reports as "the stop did nothing and
 * something is still running", and this is the one lever that ends it: the engine's own
 * `AsyncJobManager`, scoped to this session's agent id, which is also what its `dispose()` uses.
 *
 * A session whose agent id cannot be read cancels nothing: the filter is what scopes the kill to
 * this conversation, and an unscoped `cancelAll` would end every job in the process - the one
 * mistake this must not make. The ids are returned because a cancelled job's result is still a
 * delivery the stop has to silence (see `stop-results.ts`).
 */
function cancelBackgroundJobs(agent: AgentSession, reason: string): { ids: string[]; count: number } {
  const manager = agent.asyncJobManager
  const ownerId = agent.getAgentId()
  if (manager === undefined || ownerId === undefined) return { ids: [], count: 0 }
  const running = runningJobs(agent)
  if (running.length === 0) return { ids: [], count: 0 }
  manager.cancelAll({ ownerId }, reason)
  return { ids: running.map(job => job.id), count: running.length }
}

/**
 * What a stop can end right now: the children this host can still cancel, and the background jobs
 * the engine still runs for this session.
 *
 * The counts `stopSession` answers with, and the ones a forced teardown has to read *before* it runs
 * - disposing the record is what ends them, and afterwards there is nothing left to count. Read here
 * once so both callers scope them the same way, under the session's own agent id.
 */
export function cancellableCounts(
  live: Pick<LiveSession, 'agent' | 'subagents'>,
): { subagents: number; jobs: number } {
  const ownerId = live.agent.getAgentId()
  if (ownerId === undefined) return { subagents: 0, jobs: 0 }
  return {
    subagents: live.subagents.liveIds(ownerId).length,
    jobs: runningJobs(live.agent).length,
  }
}

/**
 * Ends one of this session's background jobs, by the id its state frame published.
 *
 * The per-job form of {@link cancelBackgroundJobs}, for a reader who wants one of them gone rather
 * than all of them. Ownership is checked the same way and for the same reason: the job manager is
 * process-wide, so an id belonging to another conversation would otherwise be a cross-session kill.
 * `false` means the job is not this session's, or it had already settled - not a failure, because
 * what the caller wanted ("this job is over") is true either way.
 */
export function cancelBackgroundJob(agent: AgentSession, jobId: string): boolean {
  const manager = agent.asyncJobManager
  const ownerId = agent.getAgentId()
  if (manager === undefined || ownerId === undefined) return false
  const job = manager.getJob(jobId)
  if (job === undefined || job.status !== 'running' || job.ownerId !== ownerId) return false
  job.abortController.abort('stopped by the desktop host')
  return true
}

/**
 * Stops one session's work: its running turn, its running children, and its background jobs.
 *
 * All three are "work the user asked to stop", and they come apart in exactly the cases that
 * matter. A detached `task` batch keeps running while the turn is idle, so `isStreaming` alone
 * would answer `aborted:false` to a stop control that has something to stop. An auto-backgrounded
 * bash or eval job is invisible to the child set entirely - it is not a registered subagent - so a
 * stop built on the children alone left it running with nothing to cancel. And the background work
 * the engine reports as `hasPendingAsyncWork` can outlive both. The facts that make a session
 * working are read through the same helper the eviction and release gates use (`isWorking`); a
 * session with none of them is answered `aborted:false`, and republishes its state view on the way
 * out - that answer is a reading of the truth, and it is the only correction a screen whose last
 * snapshot still says "streaming" will ever get (see the branch's own note).
 *
 * The turn is aborted first, then waited on for `graceMs`; the children and the jobs are cancelled
 * whether or not it settled. That order is the point: a turn that ignores its abort used to throw
 * before either of them was touched, which is precisely the report this shape removes - the user
 * pressed stop, the turn kept running, and the subagents and background jobs it had started kept
 * running with it. A turn that outlasts its window does not turn the answer into a failure either:
 * everything the stop could reach is ended and published, and `remaining` names the turn so the
 * screen offers the forced stop.
 *
 * The reader's own queued input is withdrawn before any of it (see `StopOutcome.restored`), because
 * the engine resumes a steering queue the moment an abort unwinds - the one thing that made a stop
 * look like it did not work. An open dialog is the same press answered: it is cancelled first, so a
 * card cannot outlive the turn that asked the question.
 *
 * What the stop takes with it is the wake-up its own kills would otherwise produce: a killed
 * child's or job's result is delivered back into this session and would start a fresh turn, so the
 * stop silences exactly the ids it ended (see `stop-results.ts`, which owns that reasoning). A
 * result already parked on the queue before the press is silenced by that same call, and counts as
 * work this stop ended: a session whose only busy fact was a parked delivery is not answered
 * `aborted:false` for it.
 *
 * `reason` is read off the request here rather than by the caller because the order is part of the
 * contract: the session's activity is stamped and its queue withdrawn before the reason is parsed,
 * so a session with nothing to stop answers `aborted:false` rather than refusing the request. The
 * engine is always told `USER_INTERRUPT_LABEL`: a stop command can only be the reader's act, and the
 * engine keys its interrupt semantics off that exact string.
 */
export async function stopSession(
  port: SessionStopPort,
  live: LiveSession,
  reason: unknown,
  graceMs: number = STOP_ABORT_GRACE_MS,
): Promise<StopOutcome> {
  live.lastActivityMs = Date.now()
  const requested = text(reason, 'reason', false)
  // The reader's own queued input goes first, before anything is aborted: a steering message left
  // in the queue is a turn the engine starts the moment this abort unwinds (`#drainStrandedQueued
  // Messages` -> `#scheduleQueuedMessageDrain`), which is what made a stop read as "it kept going".
  // Withdrawing first is the engine's own terminal rule for Esc and its RPC host's
  // `abort_and_restore_queue`; what it hands back goes to the screen as `restored`.
  const restored = withdrawQueuedMessages(live.agent)
  // An open dialog is the turn waiting on the reader - an approval, an `ask`, a host prompt. The
  // press is their answer, and a card left open after the turn it belonged to is gone would keep
  // asking a question nothing can act on (the engine is not waiting for it any more). Cancelled
  // first, so the tool that asked is released before the abort lands.
  const dialogs = live.ui.cancelAll()
  if (!isWorking(live) && restored.length === 0 && dialogs === 0) {
    logLine(`session ${live.sessionId} stop requested, nothing to stop`)
    // The press is also a reading of the truth, and the one every other "working" surface needs.
    // This side has just answered from the same facts the eviction and release gates read that this
    // conversation has nothing in flight; a screen whose last snapshot still said otherwise (a
    // snapshot built inside the turn that has since ended) has no other frame coming to correct it,
    // and used to keep drawing 「工作中…」 with this stop as its only verb (2026-10-26, user report).
    // Publishing the view here is the correction, and it costs one frame on a path that answers
    // `aborted:false` anyway.
    emitSessionState(live)
    return { aborted: false, cancelledSubagents: 0, cancelledJobs: 0, remaining: [], restored: [] }
  }
  // Who stopped what, and in whose words. A stop is the one lever that ends work the user asked
  // for, and the command carries no caller of its own, so this line is the only record of a
  // request's origin once the turn it ended has been read back out of its transcript - the engine
  // keeps the reason on the aborted message, and nothing else says a stop was ever asked for.
  logLine(
    `session ${live.sessionId} stop requested: ${requested ?? 'the reader stopped it'}` +
      (restored.length > 0 ? ` (${restored.length} queued message(s) withdrawn)` : '') +
      (dialogs > 0 ? ` (${dialogs} dialog(s) dismissed)` : ''),
  )
  // A decided goal continuation is this stop's to cancel before it starts: the controller voids it
  // and keeps the aborted goal paused until the operator resumes, exactly as the engine's RPC host
  // does on abort.
  live.goal.stopForHostAbort()
  // A loop that keeps submitting through a stop would make the stop button a no-op after one
  // turn: the terminal's Esc suspends the loop too, and the reader re-arms it with `/loop`.
  pauseLoop(live.agent)
  // A cleanse is a background run the stop button owns too: its signal is the only cancel the
  // engine's own UI uses.
  abortCleanse(live.agent)
  // A side question is its own ephemeral run: the stop ends it too, and the side panel keeps the
  // engine's own `cancelled` checkpoint as its ending.
  cancelBtw(live.agent)
  // A submission the engine has taken but not started yet is not `isStreaming` - the prompt was
  // accepted and the turn it will run is still being prepared (`hasAdmittedSubmission`: image
  // normalization and the like) - and it is still this stop's to end. Aborting in that window is
  // what cancels the preparation, so skipping it answered "nothing to stop" to a press that had a
  // turn under it, and let that turn run on.
  const stoppingTurn = live.agent.isStreaming || live.agent.hasAdmittedSubmission
  // A compaction is not a turn, but `abort()` is the engine's own cancel for it (it begins with
  // `abortCompaction`), and `isWorking` above already says why the press has to reach it.
  const stoppingCompaction = live.agent.isCompacting
  if (stoppingTurn || stoppingCompaction) {
    // `abort()` is the whole unwind (it resolves once the engine is idle and its own post-abort
    // cleanup has run), and the reader is waiting on this answer - so it is waited on for the
    // stop's window and not for as long as a stuck turn takes. The engine's reason is the engine's
    // own user-interrupt label: that is what makes this read as the reader's act rather than as an
    // internal lifecycle abort (see `USER_INTERRUPT_LABEL`).
    const aborting = live.agent.abort({ reason: USER_INTERRUPT_LABEL }).catch(error => {
      logError(`session ${live.sessionId} abort failed`, error)
    })
    await within(aborting, graceMs)
  }
  // The engine's own bookkeeping is the truth about whether the turn actually let go; a promise
  // that resolved is only one way of saying so.
  const settled = !live.agent.isStreaming && !live.agent.hasAdmittedSubmission
  const childIds = live.subagents.liveIds(live.agent.getAgentId())
  // A child's abort waits for its own turn, so this wait is bounded like the parent's: the stop is
  // not the place to hang on a child that a forced stop will end.
  const cancelling = live
    .subagents
    .cancel(live.agent.getAgentId(), USER_INTERRUPT_LABEL)
    .catch(error => {
      logError(`session ${live.sessionId} child cancel failed`, error)
      return { ended: [] as string[], killed: 0 }
    })
  const cancelled =
    (await within(cancelling, STOP_CHILD_CANCEL_GRACE_MS)) ??
    // Past the window the cancellation is still running; every child it was aimed at is silenced,
    // because the wake a kill produces is the one thing a stop must never answer with.
    { ended: childIds, killed: 0 }
  const jobs = cancelBackgroundJobs(live.agent, USER_INTERRUPT_LABEL)
  const dropped = silenceStoppedResults(live.agent, port.sdk.asyncResultMessageType, [
    ...cancelled.ended,
    ...jobs.ids,
  ])
  if (dropped > 0) logLine(`session ${live.sessionId} dropped ${dropped} pending background result(s) on stop`)
  emitSessionState(live)
  if (!settled) {
    // Everything this stop could reach has been ended and published above; the turn itself is the
    // one thing left, and `remaining` names it. The caller draws the forced stop from that word
    // rather than from a failed call: the stop did land, it just could not finish the turn, and the
    // input it withdrew has to travel back with the answer either way.
    logLine(`session ${live.sessionId} stop left its turn running past ${graceMs} ms`)
  }
  return {
    aborted:
      stoppingTurn ||
      stoppingCompaction ||
      restored.length > 0 ||
      dialogs > 0 ||
      cancelled.killed > 0 ||
      jobs.count > 0 ||
      dropped > 0,
    cancelledSubagents: cancelled.killed,
    cancelledJobs: jobs.count,
    remaining: busyFacets(live),
    restored,
  }
}

/**
 * Withdraws the reader's own queued input, as text, before a stop aborts.
 *
 * A failure here must not take the stop with it: the queue is a courtesy to the reader's words,
 * while ending the turn is the press. An engine that refuses the withdrawal is reported on the
 * host's log and the stop goes on without it - the worst outcome is the old behaviour, not a stop
 * that throws.
 */
function withdrawQueuedMessages(agent: AgentSession): string[] {
  try {
    const withdrawn = agent.clearQueue({ forInterrupt: true })
    return [...withdrawn.steering, ...withdrawn.followUp]
      .map(message => message.text.trim())
      .filter(message => message !== '')
  } catch (error) {
    logError('withdrawing the queued messages before a stop failed', error)
    return []
  }
}

/**
 * Waits for one promise, but not past `graceMs`.
 *
 * `null` means the window elapsed first. The work is not cancelled - it is the engine's own unwind,
 * and there is no handle to take it back - so every caller attaches its own failure handler to the
 * promise before racing it, and treats `null` as "still running", which is what `remaining` reports.
 */
async function within<T>(work: Promise<T>, graceMs: number): Promise<T | null> {
  const settle = Promise.withResolvers<null>()
  const timer = setTimeout(() => settle.resolve(null), graceMs)
  try {
    return await Promise.race([work, settle.promise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turns a change of this session's live child set into the frames that report it.
 *
 * The set is part of the session's busy fact, so a child appearing or settling changes the state
 * view: without a republished snapshot a screen that reads "still working" from `state` would
 * keep saying so after the last child settled, because the engine's own bookkeeping
 * (`pendingAsyncWork`) can still read true while the child's job row settles.
 *
 * It is also an edge a deferred release may be waiting for: a child's settled frame arrives on
 * the session's bus, not on the session's own event stream, so a handed-back session whose only
 * remaining work was children is released from here.
 */
export function noteChildSet(port: SessionStopPort, live: LiveSession): void {
  emitSessionState(live)
  releaseWhenDone(port, live)
}

/**
 * Calls off the deferred release a hand-back armed: a screen is using this session again.
 *
 * Every path that rejoins a session goes through here - a prompt, an `open` that finds it
 * loaded, an activation that races the loaded copy - because none of them may leave the armed
 * release in place: it disposes the record the moment the work it was waiting on ends, and the
 * screen that just came back would then be answered `session_not_found`.
 */
export function callOffRelease(live: LiveSession): void {
  live.releasePending = false
}

/**
 * Releases a handed-back session once its work is over.
 *
 * The one gate both edges read: an engine edge (the event stream of the session itself) and the
 * child-set edge (`noteChildSet`). Asking the busy fact rather than assuming keeps the two from
 * carrying a copy each of what "over" means.
 */
export function releaseWhenDone(port: SessionStopPort, live: LiveSession): void {
  if (live.releasePending && !isWorking(live)) scheduleRelease(port, live)
}

/**
 * Schedules the disposal of a session its screen handed back while it was still working.
 *
 * Deferred to the next turn of the loop rather than run here: the edge that says the work is
 * over is emitted from inside the engine's own dispatch, and tearing a session down inside that
 * dispatch would close the pipe it is still writing through.
 */
function scheduleRelease(port: SessionStopPort, live: LiveSession): void {
  if (live.releaseScheduled) return
  live.releaseScheduled = true
  setTimeout(() => {
    void releaseIfDone(port, live)
  }, 0)
}

/** Drops a handed-back session once nothing is left for it to finish. */
async function releaseIfDone(port: SessionStopPort, live: LiveSession): Promise<void> {
  live.releaseScheduled = false
  // Anything can have happened between the schedule and this run: the session may have been
  // closed, evicted, re-opened by a screen that came back to it, or given new work - and each of
  // those ends the release on its own terms, so the flag is left as it was found.
  if (!live.releasePending || !port.held(live)) return
  // The same busy fact eviction uses: a handed-back session still holding children is not done,
  // even though its turn is over - it is released from the live-set edge that ends that work
  // (`noteChildSet`), or from a later engine edge.
  if (isWorking(live) || live.agent.queuedMessageCount > 0) return
  live.releasePending = false
  port.drop(live.sessionId)
  await disposeSession(live, 'session_close')
  // The record is out of the registry, so the workspace's other conversations - if any - are what
  // the release has to leave alone: the language servers of a workspace are shared, and only the
  // one this conversation emptied may be stopped (`session-lifecycle.ts`).
  if (!port.usesWorkspace(live.cwd)) await releaseWorkspaceLsp(port.sdk, live.cwd, 'session_close')
  logLine(`session ${live.sessionId} released after its work ended`)
}

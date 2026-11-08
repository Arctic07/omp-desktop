import type { BackgroundJob, SubagentRow } from '@/api/session-types'
import type { ToolMessage } from './conversation-rows.ts'

/**
 * One child of a `task` call, as the roster row draws it.
 *
 * The fields are the engine's own reports, merged from the two rosters a call leaves behind. This
 * module is pure so the merge rules can be checked without a renderer: what a row says about a
 * child is the one thing the reader judges the call by, and the live and recorded sides can
 * disagree.
 */
export interface RosterEntry {
  id: string
  agent: string
  description: string | null
  status: string
  toolCount: number | null
  tokens: number | null
  durationMs: number | null
  currentTool: string | null
  /** The arguments of the call in flight, when the live roster reports them. */
  currentToolArgs: string | null
  lastIntent: string | null
  /** The model it ran on, as `<provider>/<id>`; null until a report resolved one. */
  model: string | null
  /** The task book the engine handed the child, when a live frame carried it. */
  assignment: string | null
  /** The calls the live roster is still carrying, most recent last. */
  recentTools: readonly { tool: string; args: string }[]
  /** The newest output lines the live roster is still carrying. */
  recentOutput: readonly string[]
  /** The host's first sighting of the child, for the live clock; `0` when it was never reported. */
  startedAt: number
  /** A `task` child that outlived its call and kept running in the background. */
  detached: boolean
  /** The settled result was cut short. */
  truncated: boolean
  /** The child's process exit code, when it has one. */
  exitCode: number | null
}

/** Whether a child's word is one only an ending earns. */
export function settledStatus(
  status: string | undefined,
): status is 'completed' | 'failed' | 'aborted' {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

/** The engine's ids this call's own roster can name. */
function subagentIdsOf(message: ToolMessage): string[] {
  const fromDetails = message.details?.subagents?.map((child) => child.id ?? '') ?? []
  return fromDetails.filter(Boolean)
}

/**
 * The children one `task` call reports, live roster first and the call's own result filling the gaps.
 *
 * A call reports its children twice: the live roster (`state/session-record.ts::subagents`, updated
 * by `subagent_updated` frames while they run) and the structured half of its own result
 * (`details.subagents`, which a reopened conversation reads back from disk). Neither is complete on
 * its own — a conversation read back has no live roster, and a call still running has no result yet
 * — so they are merged by the engine's own subagent id.
 *
 * **A settled word outranks a running one, whichever side carries it.** A child does not go back to
 * running, and either roster can be the stale one: the live map after its last frame, or the call's
 * result when it answered before the child did. "Not running" has to stay not running.
 *
 * **A finished call with a detached child is settled by the host's running-job list.** A `task` call
 * can answer while its children keep working; a `task` job's id is the child's own id, so once the
 * call is over a child that is not in `backgroundJobs` is not running. The roster frame can stop
 * before that, and a row that keeps spinning beside a completed call is the mismatch this fixes.
 * A child no source describes is `unknown`, which draws no claim at all rather than a success.
 */
export function rosterOf(
  message: ToolMessage,
  subagents: Record<string, SubagentRow>,
  backgroundJobs: readonly BackgroundJob[] | undefined,
): RosterEntry[] {
  const entries = new Map<string, RosterEntry>()
  for (const child of message.details?.subagents ?? []) {
    const id = child.id ?? child.name ?? ''
    if (!id) continue
    entries.set(id, {
      id,
      agent: child.agent,
      description: child.description ?? null,
      status: child.status ?? (child.exitCode === 0 ? 'completed' : 'failed'),
      toolCount: child.toolCount ?? null,
      tokens: child.tokens,
      durationMs: child.durationMs,
      currentTool: child.currentTool ?? null,
      currentToolArgs: null,
      lastIntent: child.lastIntent ?? null,
      model: child.model ?? null,
      assignment: null,
      recentTools: [],
      recentOutput: [],
      startedAt: 0,
      detached: false,
      truncated: child.truncated ?? false,
      exitCode: child.exitCode,
    })
  }
  // A live frame can name a child before the call's own result does - and can keep naming one the
  // call's result never mentions (a detached batch). The child's own parent is the call id, so that
  // is what decides which rows belong to this card; without it, those children had no row at all.
  const ids = new Set(subagentIdsOf(message))
  for (const [id, live] of Object.entries(subagents)) {
    if (live.parentToolCallId === message.toolCallId) ids.add(id)
  }
  for (const id of ids) {
    const live = subagents[id]
    if (!live) continue
    const previous = entries.get(id)
    const status = settledStatus(previous?.status)
      ? previous!.status
      : settledStatus(live.status)
        ? live.status
        : live.status || previous?.status || 'pending'
    entries.set(id, {
      id,
      agent: live.agent || previous?.agent || '',
      description: live.description ?? previous?.description ?? null,
      status,
      toolCount: live.toolCount ?? previous?.toolCount ?? null,
      tokens: live.tokens ?? previous?.tokens ?? null,
      durationMs: live.durationMs ?? previous?.durationMs ?? null,
      currentTool: live.currentTool ?? previous?.currentTool ?? null,
      currentToolArgs: live.currentToolArgs ?? previous?.currentToolArgs ?? null,
      lastIntent: live.lastIntent ?? previous?.lastIntent ?? null,
      model: live.model ?? previous?.model ?? null,
      assignment: live.assignment ?? previous?.assignment ?? null,
      recentTools: live.recentTools,
      recentOutput: live.recentOutput,
      startedAt: live.startedAt || previous?.startedAt || 0,
      detached: live.detached || previous?.detached === true,
      truncated: previous?.truncated ?? false,
      exitCode: previous?.exitCode ?? null,
    })
  }

  if (message.state === 'running') return [...entries.values()]
  const runningJobs = new Set(
    (backgroundJobs ?? []).filter((job) => job.type === 'task').map((job) => job.id),
  )
  return [...entries.values()].map((row) =>
    (row.status === 'running' || row.status === 'pending') && !runningJobs.has(row.id)
      ? { ...row, status: 'unknown' }
      : row,
  )
}

/** The words a `task` call's own row states, which are the ones a tool row can draw. */
export type TaskRowStatus = 'running' | 'success' | 'error' | 'cancelled'

/**
 * What a `task` call's row states, from the call's own outcome and the roster it drew.
 *
 * The call's word alone is not the row's. A detached spawn answers within its first milliseconds
 * and leaves children working for minutes, so the row follows them while they work (2026-10-21,
 * reader report: the card said 运行中 while the row above it said 已完成). The same holds at the
 * other end: an abort settles every child as `aborted` while the call keeps the `success` it earned
 * when it returned, and a card drawing 已完成 beside a roster the reader stopped is the same
 * contradiction (2026-10-23, reader report: 中止后 task 的总状态仍是 已完成). So the children
 * settle the row: live ones make it running, a failed one makes it failed, an aborted one makes it
 * cancelled — the settled words rank over the call's, and an abort is not a failure.
 *
 * A call that failed keeps its failure whatever the roster says: the call itself is what did not
 * run, and the children it never spawned cannot outvote that.
 */
export function taskRowStatus(
  callStatus: 'running' | 'success' | 'error',
  rows: readonly RosterEntry[],
): TaskRowStatus {
  if (callStatus === 'error') return 'error'
  if (rows.some((row) => row.status === 'running' || row.status === 'pending')) return 'running'
  if (rows.some((row) => row.status === 'failed')) return 'error'
  if (rows.some((row) => row.status === 'aborted')) return 'cancelled'
  return callStatus
}

/**
 * A task book's first line, with the markdown a prompt is written in stripped off.
 *
 * An engine that has not labelled a child yet hands its assignment over instead, and an assignment
 * opens like a document (`# Target …`, `**前端**`, `` `path` ``): printed as it arrives, that is a
 * page of markup squeezed into one row. The row states the line the reader would read first — the
 * whole book is its conversation's own content now — and the section words such a book opens with
 * (`# Target`, `# Change`) name the section rather than the work: a heading that carries its own
 * sentence gives that sentence, and one that stands alone gives up its place to the next line.
 */
const SECTION_HEADING = /^(target|goal|context|change|acceptance|background|notes?|steps?|objective|scope|task)\b(?:[:：]\s*|\s+|$)/i

export function taskLabel(text: string | null): string {
  // Line by line, stopping at the first answer: this runs for every roster row on every frame of a
  // streaming turn, and the label is almost always the first line. Normalizing the whole task book
  // first turned each frame into a pass over a document that only had to give up one line.
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^#+\s*/, '')
      .replace(/^[-*>+]\s+/, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line === '') continue
    const rest = line.replace(SECTION_HEADING, '').replace(/^[\s:：|—-]+/, '').trim()
    if (rest !== '') return rest
  }
  return ''
}

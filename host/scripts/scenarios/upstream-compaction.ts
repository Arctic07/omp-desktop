/**
 * An upstream endpoint that compacts the conversation instead of answering it.
 *
 * The unit tests (`src/upstream-compaction.test.ts`) decide which replies are adoptable. This
 * scenario is the other half, against the real engine: the reply arrives as the turn's assistant
 * message after a tool result, the host arms the summary, the engine's `session_before_compact`
 * hook hands it back in place of a summarizer call, the compaction is committed - and the turn then
 * continues, which is the whole point. A conversation left ended on that summary would re-send the
 * same oversized history on the next prompt and be summarized again.
 *
 * What it proves, in order: the tool call ran, the session file now holds a compaction entry whose
 * summary is the endpoint's own text and whose `fromExtension` says the host supplied it, and the
 * host's next request to the model was its own resume nudge - the provider's record of answered
 * prompts is what shows that, not the end state.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { workspace } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { selectModel, waitIdle } from './session-flow.ts'

const TARGET = path.join(workspace, 'compaction-target.txt')

/**
 * The history the endpoint's summary replaces has to be big enough for the engine to cut.
 *
 * `prepareCompaction` keeps the last `keepRecentTokens` and returns nothing when that tail is the
 * whole branch, so a conversation of two small tool results would answer
 * `Nothing to compact (session too small)` and prove nothing about the commit. The smoke fixture
 * lowers that tail to 400 tokens (`scripts/smoke.ts`), and this whole-file read puts one tool result
 * well past it.
 */
const HISTORY = path.join(workspace, 'compaction-history.txt')

/** The marker the mock provider's summary carries. */
const MARKER = 'adopt this summary'

interface CompactionEntry {
  readonly type: string
  readonly summary?: string
  readonly fromExtension?: boolean
  readonly tokensBefore?: number
  readonly firstKeptEntryId?: string
}

/** The compaction entries the session file holds, in file order. */
function compactions(sessionFile: string): CompactionEntry[] {
  const rows: unknown[] = []
  for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!line.includes('"compaction"')) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A half-written last line is the turn still going; the next read sees it whole.
    }
  }
  return rows.filter(
    (row): row is CompactionEntry =>
      typeof row === 'object' && row !== null && (row as { type?: unknown }).type === 'compaction',
  )
}

export const upstreamCompactionScenarios: Record<string, Scenario> = {
  async 'upstream-compaction'(host, report, provider) {
    fs.mkdirSync(workspace, { recursive: true })
    fs.rmSync(TARGET, { force: true })
    fs.writeFileSync(HISTORY, `${'the conversation the endpoint summarized, line by line.\n'.repeat(3000)}`, 'utf8')
    const opened = await host.response(host.send({ type: 'session_open', cwd: workspace }))
    const data = opened.data as Record<string, unknown> | undefined
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
    const sessionFile = typeof data?.sessionFile === 'string' ? data.sessionFile : ''
    report.record('upstream.open', opened.success === true && sessionId !== '' && sessionFile !== '', JSON.stringify(data ?? opened).slice(0, 200))
    await selectModel(host, sessionId, report, 'upstream')

    // The history the adopted summary is supposed to replace, read into the branch whole.
    const filled = await host.response(
      host.send({ type: 'session_prompt', sessionId, message: `read-whole ${HISTORY}` }),
      60_000,
    )
    report.record('upstream.filled', filled.success === true, JSON.stringify(filled.data ?? filled).slice(0, 120))
    await host.waitFor('agent_end', frame => frame.sessionId === sessionId, 120_000)
    await waitIdle(host, sessionId)

    const endingsBefore = host.of('agent_end').length
    const ack = await host.response(
      host.send({ type: 'session_prompt', sessionId, message: `compact-after-tool ${TARGET} written` }),
      60_000,
    )
    report.record('upstream.ack', ack.success === true, JSON.stringify(ack.data ?? ack).slice(0, 200))

    // The tool result came back and the endpoint answered with a summary; the host compacts and
    // continues, so this prompt produces endings of its own.
    await host.waitFor(
      'agent_end',
      frame => frame.sessionId === sessionId && host.of('agent_end').indexOf(frame) >= endingsBefore,
      120_000,
    )
    // The adoption starts on that ending and waits for the settle, so the file above has to be
    // read after the continuation turn has run too.
    await host.waitFor('agent_end', frame => frame.sessionId === sessionId && host.of('agent_end').indexOf(frame) > endingsBefore, 60_000)

    const wrote = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : 'missing'
    report.record('upstream.tool-ran', wrote === 'written', wrote)

    const entries = compactions(sessionFile)
    const adopted = entries.find(entry => entry.summary?.includes(MARKER))
    report.record(
      'upstream.compacted',
      adopted !== undefined && adopted.fromExtension === true,
      JSON.stringify(entries.map(entry => ({ fromExtension: entry.fromExtension, tokensBefore: entry.tokensBefore, summary: entry.summary?.slice(0, 40) }))),
    )

    // The continuation is what the engine saw next: its own resume nudge, not a user message.
    const seen = provider?.seen ?? []
    const resumed = seen.some(text => text.startsWith("Resume the user's latest intent"))
    report.record('upstream.continued', resumed, JSON.stringify(seen.map(text => text.slice(0, 60))))

    const endings = host.of('agent_end').filter(frame => frame.sessionId === sessionId).length
    report.record('upstream.turn-ended-twice', endings >= 2, `${String(endings)} ending(s)`)

    const closed = await host.response(host.send({ type: 'session_close', sessionId }))
    report.record('upstream.close', closed.success === true, 'closed')
    return { compacted: adopted !== undefined, resumed }
  },

  /**
   * The same arrival while the engine is paused for background work.
   *
   * A running job makes the settle a scheduling pause (`agent_end` with `awaitingAsyncWork`), and
   * the job's own report resumes the turn. Adopting on that ending is what keeps the wake from
   * re-sending the history the endpoint just refused; the engine owns the continuation there, so
   * the host must not add its resume nudge beside it.
   */
  async 'upstream-compaction-paused'(host, report, provider) {
    fs.mkdirSync(workspace, { recursive: true })
    fs.rmSync(TARGET, { force: true })
    fs.writeFileSync(HISTORY, `${'the conversation the endpoint summarized, line by line.\n'.repeat(3000)}`, 'utf8')
    const opened = await host.response(host.send({ type: 'session_open', cwd: workspace }))
    const data = opened.data as Record<string, unknown> | undefined
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
    const sessionFile = typeof data?.sessionFile === 'string' ? data.sessionFile : ''
    report.record('paused.open', opened.success === true && sessionId !== '' && sessionFile !== '', JSON.stringify(data ?? opened).slice(0, 200))
    await selectModel(host, sessionId, report, 'paused')

    const filled = await host.response(
      host.send({ type: 'session_prompt', sessionId, message: `read-whole ${HISTORY}` }),
      60_000,
    )
    report.record('paused.filled', filled.success === true, JSON.stringify(filled.data ?? filled).slice(0, 120))
    await host.waitFor('agent_end', frame => frame.sessionId === sessionId, 120_000)
    await waitIdle(host, sessionId)

    const endingsBefore = host.of('agent_end').length
    const ack = await host.response(
      host.send({ type: 'session_prompt', sessionId, message: `compact-while-background ${TARGET} written` }),
      60_000,
    )
    report.record('paused.ack', ack.success === true, JSON.stringify(ack.data ?? ack).slice(0, 200))

    // The summary lands while the job is still running: this settle is a pause, not an ending.
    await host.waitFor(
      'agent_end',
      frame => frame.sessionId === sessionId && frame.awaitingAsyncWork === true,
      120_000,
    )
    const paused = host
      .of('agent_end')
      .find(frame => frame.sessionId === sessionId && frame.awaitingAsyncWork === true) as Record<string, unknown> | undefined
    report.record('paused.awaiting-async-work', paused !== undefined && paused.isTerminal === false, JSON.stringify(paused ?? {}).slice(0, 200))

    // The adoption starts on that pause; the job's report then resumes the turn, so the file is
    // read after the terminal ending that follows.
    await host.waitFor(
      'agent_end',
      frame =>
        frame.sessionId === sessionId &&
        frame.awaitingAsyncWork !== true &&
        host.of('agent_end').indexOf(frame) > endingsBefore,
      180_000,
    )

    const entries = compactions(sessionFile)
    const adopted = entries.find(entry => entry.summary?.includes(MARKER))
    report.record(
      'paused.compacted',
      adopted !== undefined && adopted.fromExtension === true,
      JSON.stringify(entries.map(entry => ({ fromExtension: entry.fromExtension, summary: entry.summary?.slice(0, 40) }))),
    )

    // The engine's pending wake resumed the turn; a host nudge beside it would be a second turn.
    // Only this scenario's own requests count: one provider process answers every scenario in a run.
    const seen = provider?.seen ?? []
    const first = seen.findIndex(text => text.startsWith('compact-while-background'))
    const nudged = (first < 0 ? seen : seen.slice(first)).some(text => text.startsWith("Resume the user's latest intent"))
    report.record('paused.no-second-nudge', !nudged, JSON.stringify(seen.map(text => text.slice(0, 60))))

    const closed = await host.response(host.send({ type: 'session_close', sessionId }))
    report.record('paused.close', closed.success === true, 'closed')
    return { compacted: adopted !== undefined, nudged }
  },
}

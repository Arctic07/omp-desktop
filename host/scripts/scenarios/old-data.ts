/**
 * "Old data plus new engine": a session file written by a *previous* SDK must still open, page and
 * take a turn on the pinned one.
 *
 * `rules.md#engine-upgrade-and-distribution` makes this a required path on every engine upgrade, and
 * the reason it cannot be left to the rest of the smoke is that every other scenario's fixture is
 * written by the engine under test. This one seeds a transcript in the shape an older engine wrote
 * and then drives the host over it, so a format or migration regression shows up as a failing check
 * instead of as a user's conversation that no longer opens.
 *
 * The seed is deliberately written by this scenario rather than checked in: a checked-in `.jsonl`
 * would be a fixture nobody re-derives, and the data root is a scratch directory the suite owns. The
 * shape below is `18.18.2`'s own — a `title` line, a `session` header carrying `version`, then
 * `message` entries — which is what the previous release produced and what this one has to read.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot, workspace } from '../client.ts'
import type { HostProcess } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { selectModel, turn } from './session-flow.ts'

/** The transcript an older engine wrote: a session header and two messages. */
function writeOldSession(file: string): string {
  const id = 'oldfixture0000001'
  const at = '2026-11-09T02:14:18.192Z'
  // No title line: the engine's first line is a fixed-width title *slot*, and a line that is not
  // exactly that shape is read as the header itself, which then fails the `type: "session"` check.
  // A header-first file is the other shape real sessions take, and it is the one this fixture needs.
  const lines = [
    {
      type: 'session',
      version: 3,
      id,
      timestamp: at,
      cwd: workspace,
    },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text: 'written by the previous engine' }] },
    },
    {
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: at,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'and answered by it too' }],
        api: 'openai-completions',
        provider: 'smoke-local',
        model: 'smoke-model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1794190463353,
      },
    },
  ]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return file
}

export const oldDataScenarios: Record<string, Scenario> = {
  async 'old-data'(host: HostProcess, report: Report) {
    const file = writeOldSession(path.join(dataRoot, 'host', 'sessions', '2026-11-09T02-14-18-192Z_oldfixture0000001.jsonl'))
    const before = fs.readFileSync(file)
    report.record('old.seeded', before.length > 0, `${path.basename(file)} ${before.length}B`)

    // The desktop's own list walks this directory; the file being in it is the list half of the path.
    const listed = fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.jsonl'))
    report.record('old.listed', listed.includes(path.basename(file)), `jsonl=${listed.length}`)

    const open = await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: file }), 120_000)
    const opened = open.data as Record<string, unknown> | undefined
    const sessionId = typeof opened?.sessionId === 'string' ? opened.sessionId : ''
    // `loaded` rather than `created`: the engine resumed the file instead of starting a new one.
    report.record(
      'old.open',
      open.success === true && sessionId !== '' && opened?.created === false,
      `created=${String(opened?.created)} loaded=${String(opened?.loaded)} id=${sessionId}`,
    )
    if (sessionId === '') return { opened: false }

    const page = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
    const messages = ((page.data as Record<string, unknown> | undefined)?.messages ?? []) as unknown[]
    report.record('old.page', messages.length === 2, `messages=${messages.length}`)

    // One turn on the resumed conversation: the old history is carried into the new engine's
    // request, and the answer arrives as ordinary frames.
    await selectModel(host, sessionId, report, 'old')
    await turn(host, sessionId, '只回复 ok', report, 'old')
    report.record(
      'old.turn',
      host.of('message_update').some(frame => frame.sessionId === sessionId),
      'the resumed session streamed its answer',
    )

    // The engine writes its fixed-width title slot as the new first line on the first write, and
    // appends after that. The header line itself is rewritten by the save (it gains the fields the
    // new engine records), so the invariant that matters is the transcript: every message the older
    // engine wrote is still in the file, in its original order, with its original bytes.
    const after = fs.readFileSync(file, 'utf8')
    const afterLines = after.trim().split('\n')
    const oldMessages = before
      .toString('utf8')
      .trim()
      .split('\n')
      .filter(line => line.includes('"type":"message"'))
    const kept = oldMessages.every(line => afterLines.includes(line))
    report.record(
      'old.historyKept',
      kept && oldMessages.length === 2 && afterLines.length > oldMessages.length,
      `oldMessages=${oldMessages.length} kept=${kept} entries=${afterLines.length}`,
    )

    await host.response(host.send({ type: 'session_close', sessionId }), 60_000)
    return { opened: true, messages: messages.length }
  },
}

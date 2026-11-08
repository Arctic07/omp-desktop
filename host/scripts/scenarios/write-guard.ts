/**
 * The write guard against a real engine: two sessions, one file, real `read`/`write` tools.
 *
 * The unit tests (`src/write-guard.test.ts`) decide the table's rules. This scenario is the other
 * half: it proves the host actually installs the extension where the engine runs tool calls, that
 * the engine hands it the tool arguments as the read tool spells them (`path:1-1`), and that a
 * blocked call leaves the other conversation's bytes on disk. It is driven by the deterministic
 * provider in `scripts/mock-provider.ts` (the scenario is opt-in, because it dials a model).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { workspace } from '../client.ts'
import type { HostProcess } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { openSession, selectModel, turn, waitIdle } from './session-flow.ts'

const TARGET = path.join(workspace, 'guard-target.ts')

/** The transcript's rows, as the host pages them out; used to find the block's own words. */
async function transcript(host: HostProcess, sessionId: string): Promise<string> {
  const response = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
  return JSON.stringify(response.data ?? response)
}

export const writeGuardScenarios: Record<string, Scenario> = {
  async 'write-guard'(host: HostProcess, report: Report) {
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(TARGET, 'one\ntwo\nthree\n', 'utf8')

    const a = await openSession(host, report, 'guard.a')
    const b = await openSession(host, report, 'guard.b')
    await selectModel(host, a, report, 'guard.a')
    await selectModel(host, b, report, 'guard.b')

    // A reads a window of the file (the shape that used to evade the guard's read bookkeeping).
    await turn(host, a, `read-range ${TARGET}`, report, 'guard.a.read')

    // An existing file is not overwritten blind: B reads it whole before writing.
    const blind = host.send({ type: 'session_prompt', sessionId: b, message: `write-file ${TARGET} blind` })
    const blindAck = await host.response(blind, 60_000)
    report.record('guard.b.blindSent', blindAck.success === true, JSON.stringify(blindAck.data ?? blindAck))
    await host.waitFor('agent_end', frame => frame.sessionId === b, 60_000)
    await waitIdle(host, b)
    const blindRows = await transcript(host, b)
    report.record('guard.b.blind', blindRows.includes('has not read it'), 'an unread existing file is refused')
    report.record('guard.b.blind.no-write', fs.readFileSync(TARGET, 'utf8') === 'one\ntwo\nthree\n', 'nothing was written')

    await turn(host, b, `read-whole ${TARGET}`, report, 'guard.b.read')
    await turn(host, b, `write-file ${TARGET} from-b`, report, 'guard.b.write')
    const afterB = fs.readFileSync(TARGET, 'utf8')
    report.record('guard.b.wrote', afterB === 'from-b', afterB)

    // A now tries a whole-file write from its stale view: it must be refused, and the file must
    // still hold B's bytes.
    await turn(host, a, `write-file ${TARGET} from-a`, report, 'guard.a.blocked')
    const afterBlocked = fs.readFileSync(TARGET, 'utf8')
    const rows = await transcript(host, a)
    report.record('guard.blocked', rows.includes('has not read the whole'), 'A saw a range, not the whole file')
    report.record('guard.blocked.no-write', afterBlocked === 'from-b', afterBlocked)

    // Reading the whole current file clears it, and the same write now lands.
    await turn(host, a, `read-whole ${TARGET}`, report, 'guard.a.read-whole')
    await turn(host, a, `write-file ${TARGET} from-a2`, report, 'guard.a.write')
    const afterA = fs.readFileSync(TARGET, 'utf8')
    report.record('guard.allowed', afterA === 'from-a2', afterA)

    // A writer the guard never hears from (a command, an editor, a subagent): A's bytes are no
    // longer the file's, so the next whole-file write is refused until A reads again.
    await turn(host, a, `external-write ${TARGET} from-outside`, report, 'guard.external')
    const afterOutside = fs.readFileSync(TARGET, 'utf8')
    report.record('guard.external.wrote', afterOutside === 'from-outside', afterOutside)
    await turn(host, a, `write-file ${TARGET} from-a3`, report, 'guard.a.blocked-outside')
    report.record('guard.external.no-write', fs.readFileSync(TARGET, 'utf8') === 'from-outside', 'the external bytes survived')
    const outsideRows = await transcript(host, a)
    report.record('guard.external.blocked', outsideRows.includes('changed on disk'), 'the changed bytes are named')
    await turn(host, a, `read-whole ${TARGET}`, report, 'guard.a.read-outside')
    await turn(host, a, `write-file ${TARGET} from-a4`, report, 'guard.a.write-outside')
    const finalContent = fs.readFileSync(TARGET, 'utf8')
    report.record('guard.external.allowed', finalContent === 'from-a4', finalContent)

    const closeA = await host.response(host.send({ type: 'session_close', sessionId: a }))
    const closeB = await host.response(host.send({ type: 'session_close', sessionId: b }))
    report.record('guard.close', closeA.success === true && closeB.success === true, 'both closed')
    return { blocked: outsideRows.includes('changed on disk'), content: finalContent }
  },
}

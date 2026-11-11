/**
 * Scenario bodies the smoke driver runs, one protocol behaviour each.
 *
 * Every scenario answers through the ledger it is handed instead of throwing, so one refused
 * command does not hide the assertions that follow it, and returns the numbers its evidence file
 * should carry.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { MAX_PROMPT_BYTES, PROTOCOL_VERSION } from '../src/constants.ts'
import { dataRoot, workspace } from './client.ts'
import type { HostProcess } from './client.ts'
import { helloChecks } from './harness.ts'
import type { Report, Scenario } from './harness.ts'
import { OMP_DESKTOP_SMOKE_MODEL, OMP_DESKTOP_SMOKE_PROVIDER, OMP_DESKTOP_SMOKE_THINKING } from './fixtures.ts'
import { historyScenarios } from './scenarios/history.ts'
import { askFormScenarios } from './scenarios/ask-form.ts'
import { oldDataScenarios } from './scenarios/old-data.ts'
import { modelsScenarios } from './scenarios/models.ts'
import { pluginsScenarios } from './scenarios/plugins.ts'
import { rewindScenarios } from './scenarios/rewind.ts'
import { slashScenario } from './scenarios/slash.ts'
import { upstreamCompactionScenarios } from './scenarios/upstream-compaction.ts'
import { vibeScenarios } from './scenarios/vibe.ts'
import { writeGuardScenarios } from './scenarios/write-guard.ts'


/**
 * Points a session at the only credentialed model and at a thinking level it supports.
 *
 * Without this the engine's stored default (`high`) is rejected by the provider before any
 * streaming starts, which would look like a host failure rather than a configuration mismatch.
 */
async function selectModel(host: HostProcess, sessionId: string, report: Report, label: string): Promise<void> {
  const modelResponse = await host.response(host.send({ type: 'session_set_model', sessionId, provider: OMP_DESKTOP_SMOKE_PROVIDER, modelId: OMP_DESKTOP_SMOKE_MODEL }))
  const state = (modelResponse.data as Record<string, unknown> | undefined)?.state as Record<string, unknown> | undefined
  report.record(`${label}.setModel`, modelResponse.success === true && (state?.model as Record<string, unknown> | undefined)?.id === OMP_DESKTOP_SMOKE_MODEL, JSON.stringify(state?.thinkingLevel ?? modelResponse))
  const thinkingResponse = await host.response(host.send({ type: 'session_set_thinking', sessionId, level: OMP_DESKTOP_SMOKE_THINKING }))
  report.record(`${label}.setThinking`, thinkingResponse.success === true, JSON.stringify((thinkingResponse.data as Record<string, unknown> | undefined)?.state ?? thinkingResponse).slice(0, 200))
}

/** Scenarios that drive the handshake themselves, so they can act inside the startup window. */
export const SELF_HANDSHAKE: Record<string, true> = { preready: true }

/**
 * Scenarios that answer prompts, so the driver points the fixture at the deterministic mock
 * provider instead of the dead port. Opt-in, and named explicitly on the command line.
 */
export const MOCK_SCENARIOS: ReadonlySet<string> = new Set([
  'ask-form',
  'old-data',
  'write-guard',
  'rewind',
  'vibe',
  'stop-turn',
  'upstream-compaction',
  'upstream-compaction-paused',
])

/** Scenario bodies; each returns the numbers its evidence file should carry. */
export const scenarios: Record<string, Scenario> = {
  // The groups that live in their own modules. The table is still the one place a scenario is
  // named, so the driver's list and this record cannot drift apart.
  ...historyScenarios,
  ...askFormScenarios,
  ...oldDataScenarios,
  ...modelsScenarios,
  ...pluginsScenarios,
  ...rewindScenarios,
  ...slashScenario,
  ...upstreamCompactionScenarios,
  ...vibeScenarios,
  ...writeGuardScenarios,
  async 'closed-loop'(host, report) {
    const open = host.send({ type: 'session_open', cwd: workspace })
    const opened = await host.response(open)
    const data = opened.data as Record<string, unknown>
    report.record('session_open', opened.success === true && typeof data.sessionId === 'string', JSON.stringify({ sessionId: data.sessionId, created: data.created }))

    await selectModel(host, data.sessionId as string, report, 'closed-loop')
    const prompt = host.send({ type: 'session_prompt', sessionId: data.sessionId, message: '只回复 ok' })
    const ack = await host.response(prompt, 60_000)
    report.record('session_prompt.ack', ack.success === true, JSON.stringify(ack.data ?? ack))

    await host.waitFor('agent_end', frame => frame.type === 'agent_end', 180_000)
    const agentEnd = host.of('agent_end')[0] as Record<string, unknown>
    report.record('agent_end.isTerminal', agentEnd.isTerminal !== false, JSON.stringify(agentEnd))
    const deltas = host.of('message_update').length
    report.record('streaming', deltas > 0, `${deltas} message_update frame(s)`)

    const stateId = host.send({ type: 'session_state', sessionId: data.sessionId })
    const state = (await host.response(stateId)).data as Record<string, unknown>
    const view = state.state as Record<string, unknown>
    report.record('state.messageCount', typeof view.messageCount === 'number' && (view.messageCount as number) > 0, `messageCount=${String(view.messageCount)}`)

    const historyId = host.send({ type: 'session_history_page', sessionId: data.sessionId })
    const history = (await host.response(historyId)).data as Record<string, unknown>
    report.record('history_page', Array.isArray(history.messages) && (history.messages as unknown[]).length > 0, `totalMessages=${String(history.totalMessages)}`)

    const closeId = host.send({ type: 'session_close', sessionId: data.sessionId })
    report.record('session_close', (await host.response(closeId)).success === true, 'closed')
    const shutdownId = host.send({ type: 'host_shutdown', reason: 'smoke' })
    await host.response(shutdownId)
    const exit = await host.finish()
    report.record('host_shutdown.exit', exit === 0, `exit=${exit}`)
    return { sessionId: data.sessionId, deltas, messageCount: view.messageCount }
  },

  async health(host, report) {
    const healthId = host.send({ type: 'host_health' })
    const empty = (await host.response(healthId)).data as Record<string, unknown>
    report.record('health.empty', empty.liveSessions === 0 && empty.ready === true, JSON.stringify({ liveSessions: empty.liveSessions, lspChildren: empty.lspChildren, mcpConnections: empty.mcpConnections }))

    const opened: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const id = host.send({ type: 'session_open', cwd: workspace })
      const data = (await host.response(id)).data as Record<string, unknown>
      opened.push(data.sessionId as string)
    }
    const secondId = host.send({ type: 'host_health' })
    const two = (await host.response(secondId)).data as Record<string, unknown>
    report.record('health.twoSessions', two.liveSessions === 2, JSON.stringify({ liveSessions: two.liveSessions, sessions: (two.sessions as unknown[]).length }))

    for (const sessionId of opened) {
      host.send({ type: 'session_close', sessionId })
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    const thirdId = host.send({ type: 'host_health' })
    const after = (await host.response(thirdId)).data as Record<string, unknown>
    report.record('health.afterDispose', after.liveSessions === 0 && after.lspChildren === 0, JSON.stringify({ liveSessions: after.liveSessions, lspChildren: after.lspChildren, evicted: after.evicted }))

    host.send({ type: 'host_shutdown', reason: 'health' })
    const exit = await host.finish()
    report.record('health.exit', exit === 0, `exit=${exit}`)
    return { empty, two, after }
  },

  async errors(host, report) {
    const outside = host.send({ type: 'session_open', cwd: workspace, sessionFile: path.join(workspace, 'outside.jsonl') })
    const outsideResponse = await host.response(outside)
    report.record('invalid_session_path', outsideResponse.success === false && outsideResponse.code === 'invalid_session_path', JSON.stringify(outsideResponse))

    const unknown = host.send({ type: 'session_state', sessionId: 's0000000000000000' })
    const unknownResponse = await host.response(unknown)
    report.record('session_not_found', unknownResponse.success === false && unknownResponse.code === 'session_not_found', JSON.stringify(unknownResponse))

    const closed = host.send({ type: 'session_prompt', sessionId: 's0000000000000000', message: 'hi' })
    const closedResponse = await host.response(closed)
    report.record('session_not_found.prompt', closedResponse.success === false && closedResponse.code === 'session_not_found', JSON.stringify(closedResponse))

    const open = host.send({ type: 'session_open', cwd: workspace })
    const data = (await host.response(open)).data as Record<string, unknown>
    const firstClose = host.send({ type: 'session_close', sessionId: data.sessionId })
    const firstData = (await host.response(firstClose)).data as Record<string, unknown>
    const secondClose = host.send({ type: 'session_close', sessionId: data.sessionId })
    const secondData = (await host.response(secondClose)).data as Record<string, unknown>
    report.record('close.idempotent', firstData.closed === true && secondData.closed === false, JSON.stringify({ first: firstData, second: secondData }))

    host.sendRaw('{"type":"session_state", broken')
    host.sendRaw('[1,2,3]')
    const probe = host.send({ type: 'host_health' })
    const health = (await host.response(probe)).data as Record<string, unknown>
    report.record('malformed.counted', (health.rejectedCommands as number) >= 2, `rejectedCommands=${String(health.rejectedCommands)}`)

    const unproduced = host.send({ type: 'host_tool_call', sessionId: data.sessionId })
    const unproducedResponse = await host.response(unproduced)
    report.record('host_tool_call.refused', unproducedResponse.code === 'invalid_input', JSON.stringify(unproducedResponse))

    host.send({ type: 'host_shutdown', reason: 'errors' })
    const exit = await host.finish()
    report.record('errors.exit', exit === 0, `exit=${exit}`)
    return { firstData, secondData, rejectedCommands: health.rejectedCommands }
  },


  /**
   * The engine-state commands the four settings pages drive, and which memory backends this
   * desktop offers.
   *
   * `hindsight` is the one engine backend deliberately left out (it is a client of a remote
   * service whose endpoint and token this application neither exposes nor injects), so both halves
   * of that decision are pinned here: the published list, and the refusal of a write naming it.
   * Neither may pass silently - the engine collapses an id it does not know to `off`, which is the
   * one outcome a settings write must never produce without saying so.
   */
  async capabilities(host, report) {
    const skills = (await host.response(host.send({ type: 'skills_list', cwd: workspace }))).data as Record<string, unknown>
    report.record(
      'capabilities.skills',
      Array.isArray(skills.skills) && Array.isArray(skills.sources) && typeof skills.masterEnabled === 'boolean',
      `skills=${(skills.skills as unknown[]).length} sources=${(skills.sources as unknown[]).length} summary=${JSON.stringify(skills.summary)}`,
    )

    const mcp = (await host.response(host.send({ type: 'mcp_list', cwd: workspace }))).data as Record<string, unknown>
    report.record(
      'capabilities.mcp',
      Array.isArray(mcp.servers) && typeof mcp.live === 'boolean' && Array.isArray(mcp.errors),
      `servers=${(mcp.servers as unknown[]).length} live=${String(mcp.live)} errors=${(mcp.errors as unknown[]).length}`,
    )

    // The engine's VS Code provider reports an *absent* optional `.vscode/mcp.json` as
    // `Failed to read`, which this host drops rather than presenting as a configuration problem;
    // a file that is there but broken is reported with the path, because that is the part a reader
    // can act on. Both halves are pinned here: the page's problem list is only worth rendering if
    // it names a file someone can fix.
    report.record(
      'capabilities.mcp.absentConfigIsSilent',
      (mcp.errors as unknown[]).length === 0,
      JSON.stringify(mcp.errors),
    )

    const brokenConfigDir = path.join(workspace, '.vscode')
    const brokenConfig = path.join(brokenConfigDir, 'mcp.json')
    fs.mkdirSync(brokenConfigDir, { recursive: true })
    fs.writeFileSync(brokenConfig, '{ "mcp": }', 'utf8')
    const brokenList = (await host.response(host.send({ type: 'mcp_list', cwd: workspace }))).data as Record<string, unknown>
    const brokenErrors = (brokenList.errors ?? []) as { message?: string }[]
    fs.rmSync(brokenConfigDir, { recursive: true, force: true })
    report.record(
      'capabilities.mcp.brokenConfigNamesItsFile',
      brokenErrors.length === 1 && (brokenErrors[0].message ?? '').includes(brokenConfig),
      JSON.stringify(brokenErrors),
    )

    const memory = (await host.response(host.send({ type: 'memory_status', cwd: workspace }))).data as Record<string, unknown>
    report.record(
      'capabilities.memory',
      typeof memory.backend === 'string' && Array.isArray(memory.backends) && Array.isArray(memory.artifacts),
      `backend=${String(memory.backend)} artifacts=${(memory.artifacts as unknown[]).length}`,
    )

    const offered = memory.backends as readonly string[]
    report.record(
      'capabilities.memory.offered',
      JSON.stringify(offered) === JSON.stringify(['off', 'local', 'mnemopi', 'sharpshooter']),
      JSON.stringify(offered),
    )

    const refused = await host.response(host.send({ type: 'memory_action', action: 'set_backend', backend: 'hindsight' }))
    report.record(
      'capabilities.memory.hindsightRefused',
      refused.success === false && refused.code === 'invalid_input',
      JSON.stringify(refused),
    )

    const after = (await host.response(host.send({ type: 'memory_status', cwd: workspace }))).data as Record<string, unknown>
    report.record(
      'capabilities.memory.unchanged',
      after.backend === memory.backend,
      `backend=${String(after.backend)} before=${String(memory.backend)}`,
    )

    // Where each workspace's memory lives, for the page that lists its files. The catalog names one
    // row per requested working directory, in the order they were sent, and a root only for the
    // backend that keeps files at all.
    const secondWorkspace = path.join(workspace, 'nested-workspace')
    const catalog = (await host.response(host.send({ type: 'memory_catalog', cwds: [workspace, secondWorkspace] }))).data as Record<string, unknown>
    const catalogRows = (catalog.workspaces ?? []) as { cwd?: string; root?: string | null }[]
    report.record(
      'capabilities.memoryCatalog.shape',
      Array.isArray(catalog.workspaces)
        && catalogRows.length === 2
        && catalogRows[0]?.cwd === workspace
        && catalogRows[1]?.cwd === secondWorkspace
        && catalogRows.every(row => (row.root === null) === (catalog.localOnly !== true))
        && catalog.enabled === (catalog.backend !== 'off'),
      `localOnly=${String(catalog.localOnly)} backend=${String(catalog.backend)} rows=${JSON.stringify(catalogRows)}`,
    )

    // A root is only ever the engine's own: switching to the backend that keeps files must make the
    // catalog name exactly the directory `memory_status` derives for the same working directory, so
    // the two commands cannot drift apart. The previous backend is restored afterwards.
    const previousBackend = memory.backend
    await host.response(host.send({ type: 'memory_action', action: 'set_backend', backend: 'local' }))
    const localCatalog = (await host.response(host.send({ type: 'memory_catalog', cwds: [workspace] }))).data as Record<string, unknown>
    const localRoot = ((localCatalog.workspaces ?? []) as { root?: string | null }[])[0]?.root ?? null
    const localStatus = (await host.response(host.send({ type: 'memory_status', cwd: workspace }))).data as Record<string, unknown>
    report.record(
      'capabilities.memoryCatalog.rootMatchesStatus',
      typeof localRoot === 'string' && localRoot === localStatus.root,
      `catalog=${String(localRoot)} status=${String(localStatus.root)}`,
    )
    await host.response(host.send({ type: 'memory_action', action: 'set_backend', backend: previousBackend }))

    const tooMany = await host.response(host.send({ type: 'memory_catalog', cwds: new Array(65).fill(workspace) }))
    report.record(
      'capabilities.memoryCatalog.bounded',
      tooMany.success === false && tooMany.code === 'invalid_input',
      JSON.stringify(tooMany),
    )

    const usage = (await host.response(host.send({ type: 'usage_summary', cwd: workspace }))).data as Record<string, unknown>
    const totals = (usage.totals ?? {}) as Record<string, unknown>
    const scanned = (usage.scanned ?? {}) as Record<string, unknown>
    report.record(
      'capabilities.usage',
      typeof totals.calls === 'number' && typeof scanned.files === 'number' && Array.isArray(usage.byModel),
      `calls=${String(totals.calls)} files=${String(scanned.files)} models=${(usage.byModel as unknown[]).length}`,
    )
    // The usage page's charts read these two: one bucket per (day, model) for the trend, and both
    // ends of a session's activity for its length.
    const sessions = (usage.bySession ?? []) as Record<string, unknown>[]
    report.record(
      'capabilities.usage.tablesForTheCharts',
      Array.isArray(usage.byDayModel)
        && sessions.every(entry => 'firstActivityMs' in entry && 'lastActivityMs' in entry),
      `byDayModel=${(usage.byDayModel as unknown[]).length} sessions=${sessions.length}`,
    )

    // The two idle switches under the compaction card: the settings page reads them from this
    // payload and writes one at a time, so the round trip is pinned here - a write that did not
    // survive its flush would show the card reverting on the next read.
    const compaction = (await host.response(host.send({ type: 'compaction_status' }))).data as Record<string, unknown>
    report.record(
      'capabilities.compaction.idleReported',
      typeof compaction.enabled === 'boolean'
        && typeof compaction.idleEnabled === 'boolean'
        && typeof compaction.recapEnabled === 'boolean',
      JSON.stringify(compaction),
    )
    const toggled = await host.response(
      host.send({ type: 'compaction_set_options', idleEnabled: !compaction.idleEnabled }),
    )
    const toggledData = toggled.data as Record<string, unknown>
    report.record(
      'capabilities.compaction.idleWritten',
      toggled.success === true && toggledData.idleEnabled === !compaction.idleEnabled,
      JSON.stringify(toggledData ?? toggled),
    )
    // The other switch is not this frame's business: writing one leaf must leave the other where the
    // engine had it.
    report.record(
      'capabilities.compaction.otherUntouched',
      toggledData.recapEnabled === compaction.recapEnabled,
      `recap before=${String(compaction.recapEnabled)} after=${String(toggledData.recapEnabled)}`,
    )
    const restored = (await host.response(
      host.send({ type: 'compaction_set_options', idleEnabled: compaction.idleEnabled }),
    )).data as Record<string, unknown>
    report.record(
      'capabilities.compaction.idleRestored',
      restored.idleEnabled === compaction.idleEnabled,
      JSON.stringify(restored),
    )
    const unnamed = await host.response(host.send({ type: 'compaction_set_options' }))
    report.record(
      'capabilities.compaction.refusesEmptyWrite',
      unnamed.success === false,
      JSON.stringify(unnamed),
    )
    // A frame with one good field and one the engine refuses must leave the good one unwritten: the
    // write notifies the idle scheduler and the next flush persists it, so a partially applied frame
    // is a setting the reader never asked for, behind a reply that said `invalid_input`.
    const partial = await host.response(
      host.send({ type: 'compaction_set_options', idleEnabled: !compaction.idleEnabled, recapEnabled: 'yes' }),
    )
    const afterPartial = (await host.response(host.send({ type: 'compaction_status' }))).data as Record<string, unknown>
    report.record(
      'capabilities.compaction.rejectsAtomically',
      partial.success === false && afterPartial.idleEnabled === compaction.idleEnabled,
      `reply=${JSON.stringify(partial)} idle=${String(afterPartial.idleEnabled)} before=${String(compaction.idleEnabled)}`,
    )

    host.send({ type: 'host_shutdown', reason: 'capabilities' })
    const exit = await host.finish()
    report.record('capabilities.exit', exit === 0, `exit=${exit}`)
    return { offered, backend: memory.backend, files: scanned.files }
  },

  /**
   * The MCP definition writes: creating, editing and deleting a server in one of this application's
   * own config files.
   *
   * The three assertions that matter are the ones a page cannot see for itself: that an edit
   * replaces the keys the editor owns and leaves the rest of the stored definition alone (`enabled`,
   * `auth` - a form that dropped those would rewrite a server's authentication as a side effect of
   * changing its arguments), that the engine's own name rule is what refuses a bad name, and that a
   * definition another tool's file holds is reported as not writable here, which is what makes the
   * page offer "copy into this app" instead of an edit.
   */
  async 'mcp-write'(host, report) {
    const projectConfig = path.join(workspace, '.omp', 'mcp.json')
    const list = async (): Promise<Record<string, unknown>[]> => {
      const data = (await host.response(host.send({ type: 'mcp_list', cwd: workspace }))).data as Record<string, unknown>
      return (data.servers ?? []) as Record<string, unknown>[]
    }

    // A definition with keys the editor does not own, written the way another writer would leave it.
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true })
    fs.writeFileSync(projectConfig, JSON.stringify({
      mcpServers: {
        'smoke-probe': {
          type: 'stdio',
          command: 'node',
          args: ['a'],
          enabled: false,
          auth: { type: 'apikey', credentialId: 'kept-as-is' },
        },
      },
    }), 'utf8')

    const seeded = (await list()).find(entry => entry.name === 'smoke-probe')
    report.record(
      'mcp-write.row',
      seeded !== undefined && seeded.writable === true && seeded.scope === 'project' && seeded.command === 'node',
      JSON.stringify(seeded ?? null),
    )

    const created = await host.response(host.send({
      type: 'mcp_upsert',
      cwd: workspace,
      name: 'smoke-probe',
      scope: 'project',
      definition: { transport: 'stdio', command: 'bunx', args: ['-y', 'server-files'], env: { TOKEN: 'x' }, timeoutMs: 45_000 },
    }))
    const stored = JSON.parse(fs.readFileSync(projectConfig, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    const definition = stored.mcpServers['smoke-probe'] ?? {}
    report.record(
      'mcp-write.editKeepsTheKeysTheFormDoesNotOwn',
      created.success === true
        && definition.command === 'bunx'
        && JSON.stringify(definition.args) === '["-y","server-files"]'
        && definition.timeout === 45_000
        && definition.enabled === false
        && JSON.stringify(definition.auth) === '{"type":"apikey","credentialId":"kept-as-is"}',
      JSON.stringify(definition),
    )

    const badName = await host.response(host.send({
      type: 'mcp_upsert',
      cwd: workspace,
      name: 'bad$name',
      scope: 'user',
      definition: { transport: 'stdio', command: 'node' },
    }))
    report.record(
      'mcp-write.nameRuleIsTheEngineOwn',
      badName.success === false && badName.code === 'invalid_input' && String(badName.error).includes('Server name'),
      JSON.stringify(badName),
    )

    const removed = await host.response(host.send({ type: 'mcp_remove', cwd: workspace, name: 'smoke-probe', scope: 'project' }))
    report.record(
      'mcp-write.remove',
      removed.success === true
        && (await list()).every(entry => entry.name !== 'smoke-probe')
        && JSON.parse(fs.readFileSync(projectConfig, 'utf8')).mcpServers?.['smoke-probe'] === undefined,
      JSON.stringify(removed).slice(0, 200),
    )

    // A definition another tool owns: listed, and not writable by this application.
    const foreignDir = path.join(workspace, '.vscode')
    fs.mkdirSync(foreignDir, { recursive: true })
    fs.writeFileSync(path.join(foreignDir, 'mcp.json'), JSON.stringify({ mcp: { servers: { 'smoke-foreign': { command: 'node', args: ['f'] } } } }), 'utf8')
    const foreign = (await list()).find(entry => entry.name === 'smoke-foreign')
    fs.rmSync(foreignDir, { recursive: true, force: true })
    fs.rmSync(path.join(workspace, '.omp'), { recursive: true, force: true })
    report.record(
      'mcp-write.foreignDefinitionIsNotWritableHere',
      foreign !== undefined && foreign.writable === false && foreign.scope === null,
      JSON.stringify(foreign ?? null),
    )

    host.send({ type: 'host_shutdown', reason: 'mcp-write' })
    const exit = await host.finish()
    report.record('mcp-write.exit', exit === 0, `exit=${exit}`)
    return { exit }
  },

  async backpressure(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string

    // Stop reading: the host's writes block on a full pipe, which is the only situation in which
    // the outbound budget is ever consulted.
    host.pauseReading()
    const bursts = 3_000
    for (let index = 0; index < bursts; index += 1) {
      host.send({ type: 'session_set_name', sessionId, name: `backpressure ${index}` })
    }
    await new Promise(resolve => setTimeout(resolve, 8_000))
    await host.resumeReading()
    // Let the host drain, then ask it what the burst cost.
    await host.response(host.send({ type: 'host_health' }), 120_000)
    const health = (await host.response(host.send({ type: 'host_health' }), 120_000)).data as Record<string, unknown>
    const notices = host.of('notice').length
    const dropped = health.droppedFrames as number
    const coalesced = health.coalescedFrames as number
    report.record(
      'backpressure.bounded',
      dropped + coalesced > 0,
      `dropped=${dropped} coalesced=${coalesced} notices=${notices} bursts=${bursts}`,
    )
    report.record('backpressure.notice', notices > 0, `notices=${notices}`)
    report.record('backpressure.responsive', health.ready === true, JSON.stringify({ ready: health.ready, liveSessions: health.liveSessions }))

    // The loss has to be attributable to the conversation that lost it: `host_health` says the
    // host dropped frames, `state` says which conversation they belonged to (contract §5).
    const sessionState = (await host.response(host.send({ type: 'session_state', sessionId }), 120_000)).data as Record<string, unknown>
    const stateView = (sessionState.state ?? {}) as Record<string, unknown>
    report.record(
      'backpressure.sessionCount',
      (stateView.droppedFrames as number) > 0,
      `state.droppedFrames=${String(stateView.droppedFrames)} hostDropped=${String(dropped)} hostCoalesced=${String(coalesced)}`,
    )

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'backpressure' })
    const exit = await host.finish()
    report.record('backpressure.exit', exit === 0, `exit=${exit}`)
    return { dropped, coalesced, notices, exit }
  },

  async preready(host, report) {
    await helloChecks(host, report)
    // Everything is written before the host has said `ready`: the pipe is the only buffer, and no
    // command may be refused just for arriving during startup (contract §2.3, ruling A15).
    const okId = host.send({ type: 'hello_ok', protocol: PROTOCOL_VERSION })
    const ids: string[] = []
    for (let index = 0; index < 140; index += 1) {
      ids.push(host.send({ type: 'host_health' }))
    }
    await host.waitFor('ready', frame => frame.type === 'ready', 60_000)
    host.readyMs = Date.now() - host.spawnedAt
    const okResponse = await host.response(okId, 30_000)
    report.record('preready.hello_ok', okResponse.success === true, JSON.stringify(okResponse))

    const responses = await Promise.all(ids.map(id => host.response(id, 60_000)))
    const refused = responses.filter(response => response.success === false).length
    const notReady = responses.filter(response => response.code === 'host_not_ready').length
    report.record('preready.served', refused === 0 && responses.length === 140, `refused=${refused} of ${responses.length}`)
    report.record('preready.noHostNotReady', notReady === 0, `host_not_ready answers=${notReady}`)

    host.send({ type: 'host_shutdown', reason: 'preready' })
    const exit = await host.finish()
    report.record('preready.exit', exit === 0, `exit=${exit}`)
    return { served: responses.length, refused, notReady, exit }
  },

  async 'id-stability'(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    const file = opened.sessionFile as string

    report.record(
      'id.canonicalShape',
      !file.startsWith('\\\\?\\') && /^[A-Z]:/.test(file),
      `sessionFile=${file}`,
    )
    report.record('id.matchesDigest', /^s[0-9a-f]{16}$/.test(sessionId), `sessionId=${sessionId}`)

    // The same file spelled the way a caller may hand it back must resolve to the same session.
    const verbatim = `\\\\?\\${file}`
    const verbatimOpen = (await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: verbatim }))).data as Record<string, unknown>
    report.record('id.verbatimSpelling', verbatimOpen.sessionId === sessionId, `verbatim=${String(verbatimOpen.sessionId)} plain=${sessionId}`)

    const lowered = file.replace(/^[A-Z]/, letter => letter.toLowerCase())
    const loweredOpen = (await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: lowered }))).data as Record<string, unknown>
    report.record('id.loweredDrive', loweredOpen.sessionId === sessionId, `lowered=${String(loweredOpen.sessionId)} plain=${sessionId}`)
    report.record('id.returnedForm', loweredOpen.sessionFile === file, `returned=${String(loweredOpen.sessionFile)}`)

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'id-stability' })
    const exit = await host.finish()
    report.record('id.exit', exit === 0, `exit=${exit}`)
    return { sessionId, file, exit }
  },

  /**
   * The frame ceiling, and what the host does when a payload crosses it.
   *
   * The producer is a transcript page: `session_history_page` answers with the engine's own
   * messages, and a file whose messages are large enough makes the encoded response cross
   * `MAX_REASSEMBLED_BYTES` (64 MiB) - the one payload the writer refuses to encode, because no
   * chunk run can be assembled above it. (Until the replay journal was bounded by bytes this
   * scenario built the same failure out of a journal of 1024 title frames; the journal now sheds
   * those, so the path that can still carry a payload that large is the one tested here.)
   *
   * What is checked is the contract, not the size: the refusal is reported under the id that asked
   * (`invalid_input`), said out loud on the session's error channel, counted in `droppedFrames`,
   * and the host keeps serving.
   */
  async 'encode-failure'(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string

    // ~72 MiB of message text across 1_500 messages: above the 64 MiB reassembly ceiling once the
    // page response is encoded, and small enough per message that the session reader parses the
    // records line by line rather than rescanning one gigantic record.
    const sessionsDir = path.join(dataRoot, 'host', 'sessions')
    const fixture = path.join(sessionsDir, 'w2-encode-failure.jsonl')
    const text = 'p'.repeat(48 * 1_024)
    fs.writeFileSync(fixture, `${JSON.stringify({ type: 'session' })}\n`, 'utf8')
    for (let batch = 0; batch < 24; batch += 1) {
      let chunk = ''
      for (let index = 0; index < 64; index += 1) {
        chunk += `${JSON.stringify({
          type: 'message',
          id: `big-${batch * 64 + index}`,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })}\n`
      }
      fs.appendFileSync(fixture, chunk, 'utf8')
    }

    const page = await host.response(
      host.send({ type: 'session_history_page', sessionFile: fixture, limit: 1_600 }),
      240_000,
    )
    report.record(
      'encodeFailure.reported',
      page.success === false && page.code === 'invalid_input',
      JSON.stringify(page).slice(0, 200),
    )
    const notices = host.of('notice').filter(frame => frame.level === 'error')
    report.record('encodeFailure.notice', notices.length > 0, `error notices=${notices.length} ${JSON.stringify(notices[0] ?? {}).slice(0, 160)}`)
    const health = (await host.response(host.send({ type: 'host_health' }), 60_000)).data as Record<string, unknown>
    report.record('encodeFailure.counted', (health.droppedFrames as number) >= 1, `droppedFrames=${String(health.droppedFrames)}`)
    report.record('encodeFailure.survived', health.ready === true && health.liveSessions === 1, JSON.stringify({ ready: health.ready, liveSessions: health.liveSessions }))
    fs.rmSync(fixture, { force: true })

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'encode-failure' })
    const exit = await host.finish()
    report.record('encodeFailure.exit', exit === 0, `exit=${exit}`)
    return { reported: page.success === false, frames: notices.length, exit }
  },

  async redaction(host, report) {
    const sessionsDir = path.join(dataRoot, 'host', 'sessions')
    // A file the engine refuses to resume: its message quotes the path, which is what the host
    // has to redact before the caller sees it.
    const corrupt = path.join(sessionsDir, 'w2-corrupt.jsonl')
    fs.writeFileSync(corrupt, 'not a jsonl header\n{"type":"title","pad":1}\n', 'utf8')

    const refused = await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: corrupt }), 60_000)
    const text = String(refused.error ?? '')
    report.record(
      'redaction.failureText',
      refused.success === false && text.includes('<path>') && !text.includes(dataRoot),
      JSON.stringify(refused).slice(0, 220),
    )
    report.record(
      'redaction.keepsPunctuation',
      /<path>[")']/.test(text) || text.endsWith('<path>'),
      `error tail=${JSON.stringify(text.slice(-42))}`,
    )

    // Structural fields stay exactly as they are: redaction is for prose, not for the protocol.
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionFile = String(opened.sessionFile)
    const state = opened.state as Record<string, unknown>
    report.record(
      'redaction.structural',
      sessionFile.startsWith(dataRoot) && /^s[0-9a-f]{16}$/.test(String(opened.sessionId)) && typeof state.seq === 'number',
      JSON.stringify({ sessionFile: sessionFile.slice(0, 70), sessionId: opened.sessionId, seq: state.seq }),
    )

    const health = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    const rows = health.sessions as Array<Record<string, unknown>>
    report.record(
      'redaction.healthFields',
      typeof health.liveSessions === 'number' && rows.length === 1 && String(rows[0]?.sessionFile).startsWith(dataRoot),
      `liveSessions=${String(health.liveSessions)} sessionFile=${String(rows[0]?.sessionFile).slice(0, 60)}`,
    )

    // Conversation text is payload, never prose: a transcript that mentions paths and credentials
    // must come back byte-for-byte.
    const samples = [
      `read ${path.join(dataRoot, 'host', 'agent', 'agent.db')} before continuing`,
      'token sk-abcdef0123456789abcdef0123456789 was rejected',
      '/home/someone/private/notes.md is missing',
    ]
    const fixture = path.join(sessionsDir, 'w2-redaction.jsonl')
    fs.writeFileSync(
      fixture,
      `${samples
        .map((sample, index) =>
          JSON.stringify({
            type: 'message',
            id: `m${index + 1}`,
            timestamp: new Date(0).toISOString(),
            message: { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: sample }] },
          }),
        )
        .join('\n')}\n`,
      'utf8',
    )
    const page = (await host.response(host.send({ type: 'session_history_page', sessionFile: fixture, limit: 50 }), 60_000)).data as Record<string, unknown>
    const returned = (page.messages as Array<Record<string, unknown>>).map(message => {
      const content = message.content as Array<Record<string, unknown>>
      return String(content[0]?.text ?? '')
    })
    report.record(
      'redaction.conversationIntact',
      JSON.stringify(returned) === JSON.stringify(samples),
      JSON.stringify(returned).slice(0, 200),
    )

    host.send({ type: 'session_close', sessionId: opened.sessionId })
    host.send({ type: 'host_shutdown', reason: 'redaction' })
    const exit = await host.finish()
    report.record('redaction.exit', exit === 0, `exit=${exit}`)
    return { failureText: text, returned, exit }
  },

  async ui(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string

    // The dialog timeout in effect, which is what the F4 knob configures.
    const health = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    const expected = Number(process.env.OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS ?? 0)
    report.record(
      'ui.timeout',
      expected > 0 ? health.uiRequestTimeoutMs === expected : typeof health.uiRequestTimeoutMs === 'number',
      `uiRequestTimeoutMs=${String(health.uiRequestTimeoutMs)} OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS=${process.env.OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS ?? 'unset'}`,
    )

    // An answer for an id no dialog ever had is dropped rather than rejected: the engine ignores
    // unknown ids, and so must the host, or a late answer would fail a turn that already resumed.
    const stray = await host.response(host.send({ type: 'session_ui_response', sessionId, requestId: 'ui-9999', response: { confirmed: true } }))
    report.record('ui.strayResponse', stray.success === true, JSON.stringify(stray))

    const malformed = await host.response(host.send({ type: 'session_ui_response', sessionId, requestId: 'ui-9999', response: 'yes' }))
    report.record('ui.malformedResponse', malformed.success === false && malformed.code === 'invalid_input', JSON.stringify(malformed))

    const unknown = await host.response(host.send({ type: 'session_ui_response', sessionId: 's0000000000000000', requestId: 'ui-1', response: { confirmed: true } }))
    report.record('ui.unknownSession', unknown.code === 'session_not_found', JSON.stringify(unknown))

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'ui' })
    const exit = await host.finish()
    report.record('ui.exit', exit === 0, `exit=${exit}`)
    return { uiRequestTimeoutMs: health.uiRequestTimeoutMs }
  },

  async concurrency(host, report) {
    const first = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const second = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const firstId = first.sessionId as string
    const secondId = second.sessionId as string
    await selectModel(host, firstId, report, 'concurrency.first')
    await selectModel(host, secondId, report, 'concurrency.second')

    host.send({ type: 'session_prompt', sessionId: firstId, message: '只回复 ok' })
    host.send({ type: 'session_prompt', sessionId: secondId, message: '只回复 ok' })
    await host.waitFor('both agent_end', () => host.of('agent_end').length >= 2, 240_000)

    const frames = host.frames.filter(entry => entry.direction === 'in')
    const seqBySession = new Map<string, number[]>()
    for (const entry of frames) {
      const sessionId = entry.frame.sessionId
      if (typeof sessionId !== 'string') continue
      const seq = entry.frame.seq
      if (typeof seq !== 'number') continue
      const list = seqBySession.get(sessionId) ?? []
      list.push(seq)
      seqBySession.set(sessionId, list)
    }
    const contiguous = [...seqBySession.entries()].every(([, list]) => list.every((seq, index) => index === 0 || seq === (list[index - 1] as number) + 1))
    report.record('concurrency.seq', contiguous && seqBySession.size === 2, JSON.stringify(Object.fromEntries([...seqBySession.entries()].map(([key, list]) => [key, list.length]))))

    const firstEvents = frames.filter(entry => entry.frame.sessionId === firstId).length
    const secondEvents = frames.filter(entry => entry.frame.sessionId === secondId).length
    report.record('concurrency.bothAdvance', firstEvents > 0 && secondEvents > 0, JSON.stringify({ firstEvents, secondEvents }))

    const health = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    report.record('concurrency.liveSessions', health.liveSessions === 2, `liveSessions=${String(health.liveSessions)}`)

    for (const sessionId of [firstId, secondId]) host.send({ type: 'session_close', sessionId })
    await new Promise(resolve => setTimeout(resolve, 300))
    const afterClose = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    report.record('concurrency.lspChildren', afterClose.lspChildren === 0, `lspChildren=${String(afterClose.lspChildren)}`)
    host.send({ type: 'host_shutdown', reason: 'concurrency' })
    const exit = await host.finish()
    report.record('concurrency.exit', exit === 0, `exit=${exit}`)
    return { firstEvents, secondEvents, seqBySession: Object.fromEntries([...seqBySession.entries()].map(([key, list]) => [key, list.length])) }
  },

  async busy(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    await selectModel(host, sessionId, report, 'busy')
    host.send({ type: 'session_prompt', sessionId, message: '只回复 ok' })
    await host.waitFor('turn_start', frame => frame.type === 'turn_start', 120_000)

    const busy = host.send({ type: 'session_prompt', sessionId, message: '再回复一次 ok' })
    const busyResponse = await host.response(busy, 60_000)
    report.record('session_busy', busyResponse.success === false && busyResponse.code === 'session_busy', JSON.stringify(busyResponse))

    const abort = host.send({ type: 'session_abort', sessionId, reason: 'smoke' })
    const abortResponse = await host.response(abort, 60_000)
    report.record('session_abort', abortResponse.success === true, JSON.stringify(abortResponse.data ?? abortResponse))

    const idle = host.send({ type: 'session_state', sessionId })
    const state = (await host.response(idle)).data as Record<string, unknown>
    report.record('abort.returnsIDle', (state.state as Record<string, unknown>).isStreaming === false, JSON.stringify({ isStreaming: (state.state as Record<string, unknown>).isStreaming }))

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'busy' })
    const exit = await host.finish()
    report.record('busy.exit', exit === 0, `exit=${exit}`)
    return { busyResponse, abortResponse, state: state.state }
  },

  async 'close-idempotent'(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    for (let index = 0; index < 3; index += 1) {
      const response = await host.response(host.send({ type: 'session_close', sessionId }))
      const data = response.data as Record<string, unknown>
      report.record(`close.${index}`, index === 0 ? data.closed === true : data.closed === false, JSON.stringify(data))
    }
    const fileExists = fs.existsSync(opened.sessionFile as string)
    report.record('close.keepsFile', fileExists, String(opened.sessionFile))
    const health = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    report.record('close.lspChildren', health.lspChildren === 0, `lspChildren=${String(health.lspChildren)}`)

    // Reopening the same file must produce the same routing id.
    const reopened = (await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: opened.sessionFile }))).data as Record<string, unknown>
    report.record('close.reopenStableId', reopened.sessionId === sessionId, JSON.stringify({ before: sessionId, after: reopened.sessionId }))
    host.send({ type: 'session_close', sessionId })
    const stdinClosed = await (async () => {
      host.send({ type: 'host_shutdown', reason: 'stdin-eof' })
      return host.finish()
    })()
    report.record('close.exit', stdinClosed === 0, `exit=${stdinClosed}`)
    return { sessionId, reopened: reopened.sessionId }
  },

  /**
   * The stop path's answers, on a session with nothing to stop.
   *
   * The shape is the whole point: a stop that ends nothing has to say so (`aborted:false` and an
   * empty `remaining`) rather than answer like one that did, because the desktop words what it
   * ended and offers the forced step only when something is left. The same state frame carries the
   * two facts a reader measures a stuck run with - the silence clock (`lastEventAt`) and the
   * background roster (`backgroundJobs`) - and both have to be there whether or not this session
   * has any background work.
   *
   * What this scenario cannot manufacture is a turn that ignores its abort window: `forced:true` is
   * the answer to exactly that, and no model-free sequence produces one (see the delivery notes).
   */
  async stop(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    const state = (opened.state ?? {}) as Record<string, unknown>
    report.record('stop.lastEventAt', typeof state.lastEventAt === 'number' && state.lastEventAt > 0, JSON.stringify(state.lastEventAt))
    const jobs = state.backgroundJobs
    report.record('stop.noBackgroundJobs', jobs === undefined || (Array.isArray(jobs) && jobs.length === 0), JSON.stringify(jobs ?? null))

    const statesBefore = host.of('state').length
    const abort = await host.response(host.send({ type: 'session_abort', sessionId }))
    const outcome = (abort.data ?? {}) as Record<string, unknown>
    report.record(
      'stop.abortNothing',
      abort.success === true &&
        outcome.aborted === false &&
        outcome.cancelledSubagents === 0 &&
        outcome.cancelledJobs === 0 &&
        Array.isArray(outcome.remaining) &&
        outcome.remaining.length === 0 &&
        Array.isArray(outcome.restored) &&
        outcome.restored.length === 0,
      JSON.stringify(outcome),
    )

    // The stop that found nothing also republishes the session's state, because its own answer is a
    // reading of the truth: this side has just read the same facts the eviction gate reads, and a
    // screen whose last snapshot still said "streaming" has no other frame coming to correct it
    // (2026-10-26, user report: 「工作中… 31m」 over a finished answer, with a stop that answered
    // 「已经没有可以停止的工作了」). The frame is sent after the response, so the wait is on a
    // snapshot newer than the one the open published - that count is what proves it came from here.
    const deadline = Date.now() + 5_000
    while (host.of('state').length <= statesBefore && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const published = host.of('state').slice(statesBefore)
    const newest = (published.at(-1)?.state ?? {}) as Record<string, unknown>
    report.record(
      'stop.publishesIdleState',
      published.length > 0 && newest.isStreaming === false,
      JSON.stringify({ published: published.length, isStreaming: newest.isStreaming }),
    )

    const forced = await host.response(host.send({ type: 'session_force_stop', sessionId }))
    const forcedData = (forced.data ?? {}) as Record<string, unknown>
    report.record(
      'stop.forceStopIdle',
      forced.success === true && forcedData.forced === false && typeof forcedData.sessionFile === 'string',
      JSON.stringify(forcedData),
    )
    // Nothing needed forcing, so the record is untouched: the session still answers under its id.
    const stillLoaded = await host.response(host.send({ type: 'session_state', sessionId }))
    report.record('stop.sessionSurvives', stillLoaded.success === true, JSON.stringify(stillLoaded.success))

    // One job of a session that has none: answered, not failed - what the caller wanted is already
    // true - and the session's id is still checked, which is what keeps the verb from acting on a
    // conversation this host does not hold.
    const noJob = await host.response(host.send({ type: 'session_stop_job', sessionId, jobId: 'no-such-job' }))
    report.record('stop.stopUnknownJob', noJob.success === true && (noJob.data as Record<string, unknown> | undefined)?.stopped === false, JSON.stringify(noJob.data ?? noJob))
    const badSession = await host.response(host.send({ type: 'session_stop_job', sessionId: 's0000000000000000', jobId: 'no-such-job' }))
    report.record('stop.stopUnknownSession', badSession.success === false && badSession.code === 'session_not_found', JSON.stringify(badSession))

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'stop' })
    const exit = await host.finish()
    report.record('stop.exit', exit === 0, `exit=${exit}`)
    return { sessionId, outcome, forcedData }
  },

  /**
   * A stop pressed while a turn is actually running, which is the case the idle `stop` scenario
   * cannot reach.
   *
   * Three promises are asserted against a real engine: the stop is taken (`aborted:true`), the
   * reader's queued steer is withdrawn rather than run (`restored`), and the stop *sticks* - no
   * continuation turn starts after it. The third is the regression this scenario exists for: the
   * engine resumes a steering queue the moment an abort unwinds, so a stop that left the queue in
   * place was followed by a fresh turn milliseconds later, which a reader reports as "stop did
   * nothing" and then "it popped up a burst of notices".
   *
   * `hold` is the mock provider's never-answered request, so the turn is still in flight while the
   * stop lands.
   */
  async 'stop-turn'(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    await selectModel(host, sessionId, report, 'stop-turn')

    const startsAtPrompt = host.of('agent_start').filter(frame => frame.sessionId === sessionId).length
    const promptId = host.send({ type: 'session_prompt', sessionId, message: 'hold' })
    const promptAck = await host.response(promptId, 60_000)
    report.record('stop-turn.promptAck', promptAck.success === true, JSON.stringify(promptAck.data ?? promptAck))
    // The turn is in flight: the engine's own stream said so, not a timer. `state` frames are
    // published on edges rather than on every event, so the count on the engine event is what
    // proves the run started.
    await host.waitFor(
      'agent_start',
      frame => frame.sessionId === sessionId && host.of('agent_start').indexOf(frame) >= startsAtPrompt,
      30_000,
    )
    report.record('stop-turn.running', true, 'agent_start arrived')

    // A steer the reader typed while the turn ran: the case that used to start a new turn after the
    // stop. It is delivered as a queued steering message, not as part of any prompt already sent.
    const steerId = host.send({ type: 'session_prompt', sessionId, message: 'queued words', streamingBehavior: 'steer' })
    const steerAck = await host.response(steerId, 30_000)
    report.record('stop-turn.steerAck', steerAck.success === true, JSON.stringify(steerAck.data ?? steerAck))

    const startsBefore = host.of('agent_start').filter(frame => frame.sessionId === sessionId).length
    const abort = await host.response(host.send({ type: 'session_abort', sessionId }), 30_000)
    const outcome = (abort.data ?? {}) as Record<string, unknown>
    report.record('stop-turn.aborted', abort.success === true && outcome.aborted === true, JSON.stringify(outcome))
    report.record(
      'stop-turn.restored',
      Array.isArray(outcome.restored) && outcome.restored.includes('queued words'),
      JSON.stringify(outcome.restored ?? null),
    )

    // The abort unwinds to an idle session; the steer must not become a second turn.
    const settled = Promise.withResolvers<void>()
    setTimeout(settled.resolve, 500)
    await settled.promise
    const startsAfter = host.of('agent_start').filter(frame => frame.sessionId === sessionId).length
    const state = ((await host.response(host.send({ type: 'session_state', sessionId }))).data as Record<string, unknown>).state as Record<string, unknown>
    report.record(
      'stop-turn.noContinuation',
      startsAfter === startsBefore && state.isStreaming === false,
      JSON.stringify({ startsBefore, startsAfter, isStreaming: state.isStreaming, queued: state.queuedMessageCount }),
    )

    // A second press right after finds nothing left: no second stop is answered as if it ended work,
    // and no notice-worthy failure follows the first.
    const again = await host.response(host.send({ type: 'session_abort', sessionId }), 30_000)
    report.record(
      'stop-turn.againNothing',
      again.success === true && (again.data as Record<string, unknown> | undefined)?.aborted === false,
      JSON.stringify(again.data ?? again),
    )

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'stop-turn' })
    const exit = await host.finish()
    report.record('stop-turn.exit', exit === 0, `exit=${exit}`)
    return { sessionId, outcome, startsBefore, startsAfter }
  },
}


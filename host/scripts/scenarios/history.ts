/**
 * The scenarios that read transcripts: cold paging, wide frames, resync after a protocol hole,
 * chunked pages, and the paging cursor's own contract.
 *
 * Split out of `scenarios.ts` because they share one fixture writer and have nothing else in
 * common with the rest of the table (`rules.md#single-file-line-limit`).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { MAX_PROMPT_BYTES } from '../../src/constants.ts'
import { dataRoot, workspace } from '../client.ts'
import { OMP_DESKTOP_SMOKE_MODEL, OMP_DESKTOP_SMOKE_PROVIDER, OMP_DESKTOP_SMOKE_THINKING } from '../fixtures.ts'
import type { Scenario } from '../harness.ts'

/**
 * Writes a synthetic transcript with `count` message entries and no session header.
 *
 * The file is deliberately not a resumable session: it is the shape a session file takes after
 * external rewriting or corruption, which is exactly the case the paging rules have to survive.
 */
function writeTranscriptFixture(file: string, count: number, paddingBytes = 0): string {
  const lines: string[] = []
  for (let index = 1; index <= count; index += 1) {
    const fill = paddingBytes > 0 ? ` ${'x'.repeat(paddingBytes)}` : ''
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m${index}`,
        timestamp: new Date(0).toISOString(),
        message: {
          role: index % 2 === 0 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `message ${index}${fill}` }],
        },
      }),
    )
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

/** The text of every row a transcript page carried, in the order the page delivered it. */
function pageTexts(messages: unknown): string[] {
  return ((messages ?? []) as Array<{ content?: unknown }>).map(message => {
    const content = message.content
    if (Array.isArray(content)) {
      const part = content[0] as { text?: unknown } | undefined
      if (part !== undefined && typeof part.text === 'string') return part.text
    }
    return typeof content === 'string' ? content : ''
  })
}

/**
 * The transcript `cold` and `frames` read: real message entries with enough bulk that a wide page
 * crosses the physical frame ceiling. Written per run, so neither scenario depends on whatever
 * else happens to be in this data root.
 */
function transcriptFixture(): string {
  return writeTranscriptFixture(path.join(dataRoot, 'host', 'sessions', 'w2-transcript.jsonl'), 200, 20 * 1024)
}

/** The transcript-reading scenarios, keyed the way the driver names them. */
export const historyScenarios: Record<string, Scenario> = {
  async cold(host, report) {
    const open = host.send({ type: 'session_open', cwd: workspace })
    const opened = (await host.response(open)).data as Record<string, unknown>
    host.send({ type: 'session_close', sessionId: opened.sessionId })
    await new Promise(resolve => setTimeout(resolve, 300))

    // A transcript with real content, read from disk without the file ever being opened as a
    // session. The fixture is written here, so the assertions do not depend on what else happens
    // to be in the data root.
    const target = transcriptFixture()

    const before = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>
    const page = host.send({ type: 'session_history_page', sessionFile: target, limit: 5 })
    const pageData = (await host.response(page, 120_000)).data as Record<string, unknown>
    const after = (await host.response(host.send({ type: 'host_health' }))).data as Record<string, unknown>

    report.record('cold.noActivation', after.liveSessions === 0, JSON.stringify({ before: before.liveSessions, after: after.liveSessions }))
    const messages = pageData.messages as unknown[]
    report.record('cold.page', Array.isArray(messages) && messages.length > 0, `totalMessages=${String(pageData.totalMessages)} file=${path.basename(target)}`)

    const nextCursor = pageData.nextCursor
    if (typeof nextCursor === 'string') {
      const older = await host.response(host.send({ type: 'session_history_page', sessionFile: target, limit: 5, cursor: nextCursor }))
      const olderData = older.data as Record<string, unknown>
      report.record(
        'cold.paging',
        older.success === true && JSON.stringify(olderData.messages) !== JSON.stringify(pageData.messages),
        `nextCursor=${nextCursor} olderMessages=${(olderData.messages as unknown[]).length}`,
      )
    } else {
      report.record('cold.paging', false, 'the transcript is too short to page')
    }

    const badCursor = host.send({ type: 'session_history_page', sessionFile: target, cursor: 'nonsense' })
    const badCursorResponse = await host.response(badCursor)
    report.record('stale_cursor', badCursorResponse.code === 'stale_cursor', JSON.stringify(badCursorResponse))

    host.send({ type: 'host_shutdown', reason: 'cold' })
    const exit = await host.finish()
    report.record('cold.exit', exit === 0, `exit=${exit}`)
    return { target, totalMessages: pageData.totalMessages, before: before.liveSessions, after: after.liveSessions }
  },


  async frames(host, report) {
    const open = host.send({ type: 'session_open', cwd: workspace })
    const opened = (await host.response(open)).data as Record<string, unknown>
    const sessionId = opened.sessionId as string

    // A prompt above the physical frame ceiling arrives as an `rpc_chunk` run: the host reassembles
    // it, and serves it while it stays inside the inline prompt budget (2 MiB here, where the old
    // 512 KiB cap refused perfectly ordinary pastes).
    const accepted = 'x'.repeat(2 * 1024 * 1024)
    const acceptedId = host.sendChunked({ type: 'session_prompt', sessionId, message: accepted })
    const acceptedResponse = await host.response(acceptedId, 120_000)
    report.record(
      'chunked.promptAccepted',
      acceptedResponse.success === true,
      `${JSON.stringify(acceptedResponse).slice(0, 200)} chunkLines=${host.chunkLines}`,
    )

    // Past that budget the prompt is refused with a code - never truncated, and never written
    // somewhere the engine has no way to read back (see `MAX_PROMPT_BYTES`).
    const oversized = 'x'.repeat(MAX_PROMPT_BYTES + 1024)
    const bigId = host.sendChunked({ type: 'session_prompt', sessionId, message: oversized })
    const bigResponse = await host.response(bigId, 180_000)
    report.record(
      'chunked.promptRefused',
      bigResponse.success === false && bigResponse.code === 'invalid_input',
      `${JSON.stringify(bigResponse).slice(0, 200)} chunkLines=${host.chunkLines}`,
    )

    // Outbound frames above the ceiling are chunked too; a wide page from the transcript fixture
    // crosses it, and the driver reassembles it the same way the Rust decoder does.
    const largeFile = transcriptFixture()
    {
      const before = host.chunkLines
      const page = await host.response(host.send({ type: 'session_history_page', sessionFile: largeFile, limit: 200 }), 120_000)
      report.record(
        'chunked.pages',
        page.success === true && host.chunkLines > before,
        `bytes=${JSON.stringify(page).length} outboundChunkLines=${host.chunkLines - before}`,
      )
    }

    const duplicateA = host.send({ id: 'dup', type: 'host_health' })
    const duplicateB = host.send({ id: 'dup', type: 'host_health' })
    const first = await host.response(duplicateA)
    const second = await host.response(duplicateB)
    report.record('duplicate.id', first.id === 'dup' && second.id === 'dup', 'both answered under the same id')

    const longLine = 'y'.repeat(2 * 1024 * 1024)
    host.sendRaw(longLine)
    await new Promise(resolve => setTimeout(resolve, 400))
    const probe = host.send({ type: 'host_health' })
    const health = (await host.response(probe)).data as Record<string, unknown>
    report.record('oversized.line', (health.rejectedCommands as number) >= 1, `rejectedCommands=${String(health.rejectedCommands)}`)

    host.send({ type: 'host_shutdown', reason: 'frames' })
    const exit = await host.finish()
    report.record('frames.exit', exit === 0, `exit=${exit}`)
    return { big: bigResponse, rejectedCommands: health.rejectedCommands }
  },

  /**
   * A live conversation is read from its own transcript, not from the engine's context.
   *
   * The two are not the same array and they part company on an auto-compaction: the engine rewrites
   * `agent.messages` into the retained window plus a summary, while the branch it rewrote from keeps
   * every message it held. Reading a conversation through the context is therefore how an
   * auto-compaction makes the reader's history disappear from the screen - the conversation becomes
   * its last two rows, with no navigation rail and nothing to scroll, because what is left is
   * shorter than the pane. What this asserts is the invariant that closes that hole: a live read
   * reports exactly the messages the session's own file holds, so what a reader is shown is the
   * conversation as it was written.
   *
   * The turn is driven against the fixture's endpoint, which never answers: the prompt fails, and a
   * failed turn still writes the reader's own message and the row that reports the failure - which
   * is all the read needs to have something to count.
   */
  async transcript(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    const sessionFile = opened.sessionFile as string | null
    const ack = await host.response(host.send({ type: 'session_prompt', sessionId, message: '只回复 ok' }), 60_000)
    report.record('transcript.prompt', ack.success === true, JSON.stringify(ack).slice(0, 160))
    await host.waitFor('agent_end', frame => frame.type === 'agent_end', 120_000).catch(() => undefined)

    const live = (await host.response(host.send({ type: 'session_history_page', sessionId, limit: 400 }))).data as Record<string, unknown>
    const written = sessionFile === null || !fs.existsSync(sessionFile)
      ? -1
      : fs.readFileSync(sessionFile, 'utf8').split('\n')
        .filter(line => line.includes('"type":"message"')).length
    const total = typeof live.totalMessages === 'number' ? live.totalMessages : -1
    report.record('transcript.rows', total > 0, `live=${total}`)
    report.record(
      'transcript.isTheConversation',
      total > 0 && total === written,
      `live=${total} file=${written} entries=${Array.isArray(live.messages) ? (live.messages as unknown[]).length : 'none'}`,
    )

    host.send({ type: 'host_shutdown', reason: 'transcript' })
    const exit = await host.finish()
    report.record('transcript.exit', exit === 0, `exit=${exit}`)
    return { live: total, file: written }
  },


  async resync(host, report) {
    /** Highest sequence number this host has published for one session since `fromIndex`. */
    const maxFrameSeq = (sessionId: string, fromIndex = 0): number =>
      host.frames
        .slice(fromIndex)
        .filter(entry => entry.direction === 'in' && entry.frame.sessionId === sessionId && typeof entry.frame.seq === 'number')
        .reduce((highest, entry) => Math.max(highest, entry.frame.seq as number), 0)

    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    const file = opened.sessionFile as string
    const firstState = opened.state as Record<string, unknown>
    const firstSeq = firstState.seq
    report.record(
      'resync.open.seq',
      typeof firstSeq === 'number' && Number.isInteger(firstSeq) && firstSeq >= 0,
      `state.seq=${String(firstSeq)} maxFrameSeq=${maxFrameSeq(sessionId)}`,
    )
    report.record('resync.open.anchor', firstSeq === maxFrameSeq(sessionId), `state.seq=${String(firstSeq)} frames=${maxFrameSeq(sessionId)}`)

    // The anchor has to be the last published frame, not a constant: make the session publish two
    // more frames (rename republishes `session_info_update` + `state`) and re-read it.
    const renamed = await host.response(host.send({ type: 'session_set_name', sessionId, name: 'resync probe' }))
    report.record('resync.rename', renamed.success === true, JSON.stringify(renamed).slice(0, 160))
    const afterRename = (await host.response(host.send({ type: 'session_state', sessionId }))).data as Record<string, unknown>
    const renamedSeq = (afterRename.state as Record<string, unknown>).seq
    report.record(
      'resync.state.followsFrames',
      typeof renamedSeq === 'number' && (renamedSeq as number) > (firstSeq as number) && renamedSeq === maxFrameSeq(sessionId),
      `first=${String(firstSeq)} afterRename=${String(renamedSeq)} frames=${maxFrameSeq(sessionId)}`,
    )

    // `session_set_model` / `session_set_thinking` publish frames too, and both answer with a
    // `state`; neither touches the provider, so this covers the config paths without a model call.
    // Both are read defensively: a refused command answers without `data`, and a scenario that
    // throws here would drop every assertion after it.
    const modelResponse = await host.response(host.send({ type: 'session_set_model', sessionId, provider: OMP_DESKTOP_SMOKE_PROVIDER, modelId: OMP_DESKTOP_SMOKE_MODEL }))
    const modelState = ((modelResponse.data ?? {}) as Record<string, unknown>).state as Record<string, unknown> | undefined
    const modelSeq = modelState?.seq
    report.record('resync.setModel.anchor', modelResponse.success === true && modelSeq === maxFrameSeq(sessionId), `state.seq=${String(modelSeq)} frames=${maxFrameSeq(sessionId)} ${JSON.stringify(modelResponse).slice(0, 160)}`)
    const thinkingResponse = await host.response(host.send({ type: 'session_set_thinking', sessionId, level: OMP_DESKTOP_SMOKE_THINKING }))
    const thinkingState = ((thinkingResponse.data ?? {}) as Record<string, unknown>).state as Record<string, unknown> | undefined
    const thinkingSeq = thinkingState?.seq
    report.record(
      'resync.setThinking.anchor',
      thinkingResponse.success === true && thinkingSeq === maxFrameSeq(sessionId) && (thinkingSeq as number) > (renamedSeq as number),
      `state.seq=${String(thinkingSeq)} frames=${maxFrameSeq(sessionId)} previous=${String(renamedSeq)} ${JSON.stringify(thinkingResponse).slice(0, 160)}`,
    )

    // Reopening a session that is already loaded - the click-a-row-that-is-already-on-screen path -
    // must hand back the current anchor. Without it a caller cannot tell "nothing new" from
    // "start over", and replays the journal into the UI.
    const reopened = (await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: file }))).data as Record<string, unknown>
    const reopenedState = reopened.state as Record<string, unknown>
    report.record('resync.reopen.sameId', reopened.sessionId === sessionId, JSON.stringify({ before: sessionId, after: reopened.sessionId }))
    report.record(
      'resync.reopen.anchor',
      reopenedState.seq === thinkingSeq && (reopenedState.seq as number) >= (firstSeq as number),
      `reopened=${String(reopenedState.seq)} expected=${String(thinkingSeq)}`,
    )

    // Two consecutive reads with no frames in between must agree, so a caller polling state never
    // sees the anchor move on its own.
    const second = (await host.response(host.send({ type: 'session_state', sessionId }))).data as Record<string, unknown>
    report.record('resync.stable', (second.state as Record<string, unknown>).seq === reopenedState.seq, `a=${String(reopenedState.seq)} b=${String((second.state as Record<string, unknown>).seq)}`)

    // A cold read must not carry an anchor for a session this host has not loaded.
    host.send({ type: 'session_close', sessionId })
    await new Promise(resolve => setTimeout(resolve, 200))
    const cold = (await host.response(host.send({ type: 'session_history_page', sessionFile: file, limit: 5 }))).data as Record<string, unknown>
    report.record('resync.cold.hasNoState', cold.state === undefined, `keys=${Object.keys(cold).join(',')}`)

    // Reopening after the close rebuilds the session, so its sequence restarts (contract §2.5-6)
    // and the anchor must restart with it - while still naming the last frame of the new run.
    const rebuildFrom = host.frames.length
    const rebuilt = (await host.response(host.send({ type: 'session_open', cwd: workspace, sessionFile: file }))).data as Record<string, unknown>
    const rebuiltState = rebuilt.state as Record<string, unknown>
    report.record(
      'resync.rebuilt.seq',
      rebuilt.sessionId === sessionId && typeof rebuiltState.seq === 'number' && rebuiltState.seq === maxFrameSeq(sessionId, rebuildFrom),
      `state.seq=${String(rebuiltState.seq)} framesSinceRebuild=${maxFrameSeq(sessionId, rebuildFrom)} previousRunMax=${maxFrameSeq(sessionId)}`,
    )

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'resync' })
    const exit = await host.finish()
    report.record('resync.exit', exit === 0, `exit=${exit}`)
    return {
      sessionId,
      openSeq: firstSeq,
      afterRenameSeq: renamedSeq,
      afterSetModelSeq: modelSeq,
      afterSetThinkingSeq: thinkingSeq,
      reopenedSeq: reopenedState.seq,
      rebuiltSeq: rebuiltState.seq,
    }
  },


  async chunks(host, report) {
    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string

    // Control: a well-formed chunk run is reassembled and answered normally.
    const goodId = host.sendChunked({ type: 'session_state', sessionId }, 4096)
    const good = await host.response(goodId, 30_000)
    report.record('chunks.good', good.success === true, `chunkLines=${host.chunkLines} ${JSON.stringify(good).slice(0, 120)}`)

    // Three malformed runs, each detected immediately. None of them may end the process.
    host.sendRawChunk({ chunkId: 'bad-start', index: 1, count: 2, byteLength: 10, data: Buffer.from('abcdefghij').toString('base64') })
    host.sendRawChunk({ chunkId: 'bad-length', index: 0, count: 1, byteLength: 7, data: Buffer.from('x'.repeat(39)).toString('base64') })
    host.sendRawChunk({ chunkId: 'bad-index', index: 9, count: 1, byteLength: 4, data: Buffer.from('abcd').toString('base64') })
    await new Promise(resolve => setTimeout(resolve, 500))

    const health = (await host.response(host.send({ type: 'host_health' }), 30_000)).data as Record<string, unknown>
    report.record('chunks.counted', (health.rejectedCommands as number) >= 3, `rejectedCommands=${String(health.rejectedCommands)}`)
    report.record('chunks.survived', health.ready === true && health.liveSessions === 1, JSON.stringify({ ready: health.ready, liveSessions: health.liveSessions }))

    // The stream still works after the noise.
    const after = await host.response(host.send({ type: 'session_state', sessionId }), 30_000)
    report.record('chunks.stillServes', after.success === true, JSON.stringify(after).slice(0, 140))

    host.send({ type: 'session_close', sessionId })
    host.send({ type: 'host_shutdown', reason: 'chunks' })
    const exit = await host.finish()
    report.record('chunks.exit', exit === 0, `exit=${exit}`)
    return { rejectedCommands: health.rejectedCommands, exit }
  },


  async history(host, report) {
    const file = writeTranscriptFixture(path.join(dataRoot, 'host', 'sessions', 'w2-paging.jsonl'), 120)

    // Pages are oldest-first and the cursor carries the transcript snapshot it was issued
    // against, so a walk can append pages in arrival order and notice when the file moved.
    const first = (await host.response(host.send({ type: 'session_history_page', sessionFile: file, limit: 50 }), 60_000)).data as Record<string, unknown>
    const firstTexts = pageTexts(first.messages)
    report.record(
      'history.page1',
      first.totalMessages === 120 && firstTexts.length === 50 && first.nextCursor === 'c50@120' && firstTexts[0] === 'message 1' && firstTexts[49] === 'message 50',
      `total=${String(first.totalMessages)} count=${firstTexts.length} next=${String(first.nextCursor)} head=${firstTexts[0]} tail=${firstTexts[49]}`,
    )

    const second = (await host.response(host.send({ type: 'session_history_page', sessionFile: file, limit: 50, cursor: 'c50@120' }), 60_000)).data as Record<string, unknown>
    report.record(
      'history.page2',
      second.totalMessages === 120 && (second.messages as unknown[]).length === 50 && second.nextCursor === 'c100@120',
      `total=${String(second.totalMessages)} count=${(second.messages as unknown[]).length} next=${String(second.nextCursor)}`,
    )

    // The last page must be the last: a host that hands out a cursor it later rejects breaks the
    // walk, and the walk is the only way the frontend reaches older messages.
    const third = await host.response(
      host.send({ type: 'session_history_page', sessionFile: file, limit: 50, cursor: (second.nextCursor as string) ?? 'c100@120' }),
      60_000,
    )
    const thirdData = (third.data ?? {}) as Record<string, unknown>
    const covered = (first.messages as unknown[]).length + (second.messages as unknown[]).length + ((thirdData.messages as unknown[] | undefined)?.length ?? 0)
    report.record(
      'history.page3',
      third.success === true && (thirdData.messages as unknown[]).length === 20 && thirdData.nextCursor === undefined && covered === 120,
      `success=${String(third.success)} code=${String(third.code)} count=${(thirdData.messages as unknown[] | undefined)?.length ?? 0} next=${String(thirdData.nextCursor)} covered=${covered}`,
    )

    // The walk the desktop performs: append each page as it arrives. Reversed pages produce the
    // right rows in the wrong order - the defect this scenario exists to catch.
    const walked = [...firstTexts, ...pageTexts(second.messages), ...pageTexts(thirdData.messages)]
    report.record(
      'history.walkOldestFirst',
      walked.length === 120 && walked.every((text, index) => text === `message ${index + 1}`),
      `walked=${walked.length} head=${walked[0]} tail=${walked[walked.length - 1]}`,
    )

    // A cursor from a differently sized transcript is stale, not silently reinterpreted.
    const stale = await host.response(host.send({ type: 'session_history_page', sessionFile: file, limit: 50, cursor: 'c50@119' }), 60_000)
    report.record('history.staleSnapshot', stale.success === false && stale.code === 'stale_cursor', JSON.stringify(stale).slice(0, 180))

    // A different page size must not change the count: the window and the total come from one source.
    const wide = (await host.response(host.send({ type: 'session_history_page', sessionFile: file, limit: 1600 }), 60_000)).data as Record<string, unknown>
    report.record(
      'history.sameSource',
      wide.totalMessages === first.totalMessages && (wide.messages as unknown[]).length === 120,
      `limit1600 total=${String(wide.totalMessages)} count=${(wide.messages as unknown[]).length} vs limit50 total=${String(first.totalMessages)}`,
    )

    host.send({ type: 'host_shutdown', reason: 'history' })
    const exit = await host.finish()
    report.record('history.exit', exit === 0, `exit=${exit}`)
    return { total: first.totalMessages, covered, wideTotal: wide.totalMessages, exit }
  },
}
